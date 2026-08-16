import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from '@aws-sdk/client-sfn'
import { getConnection, getRun, updateRun } from '../lib/dynamo'
import { notifyConnection } from '../lib/wsNotify'
import type { PlanResult } from '../research/types'

const sfn = new SFNClient({})

interface WSEvent {
  requestContext: { connectionId: string }
  body?: string
}

interface ApproveBody {
  chatId: string
  runId: string
  approved: boolean
  editedPlan?: PlanResult
}

// WS action "researchApprove" — resolves the task token `AwaitApproval` (terraform/
// research.tf) is blocked on, via `.waitForTaskToken`'s SendTaskSuccess/SendTaskFailure.
// AwaitApproval has no ResultPath, so a successful SendTaskSuccess payload entirely
// replaces the state machine's state ($) — it must reconstruct every field the rest of
// the pipeline (Wave/Assess/Report) needs, not just the plan.
export const handler = async (event: WSEvent): Promise<APIGatewayProxyResultV2> => {
  const connId = event.requestContext.connectionId
  const conn = await getConnection(connId)
  if (!conn) return { statusCode: 410, body: 'Gone' }

  const body = JSON.parse(event.body ?? '{}') as ApproveBody
  const { chatId, runId, approved, editedPlan } = body

  const run = await getRun(chatId, runId)
  if (!run || run.sub !== conn.userSub) return { statusCode: 404, body: 'Not found' }
  if (run.status !== 'awaiting_approval' || !run.taskToken) return { statusCode: 409, body: 'Not awaiting approval' }

  if (!approved) {
    await sfn.send(new SendTaskFailureCommand({
      taskToken: run.taskToken,
      error: 'ResearchRejected',
      cause: 'User rejected the research plan',
    }))
    await updateRun(chatId, runId, { status: 'failed' })
    console.log(JSON.stringify({ event: 'research_approve_rejected', runId, chatId }))
    return { statusCode: 200, body: '' }
  }

  const plan = editedPlan ?? run.plan
  await sfn.send(new SendTaskSuccessCommand({
    taskToken: run.taskToken,
    output: JSON.stringify({
      chatId,
      runId,
      sub: run.sub,
      question: run.question,
      plan,
      findings: [],
      nextSubQuestions: plan.subQuestions,
      gapsNotPursued: [],
      steeringNotes: [],
      roundsSpent: 0,
      // The approving connection, not necessarily the one that started the run — refreshes
      // where Wave/Assess push progress frames if the user reconnected from another tab.
      connId,
    }),
  }))
  await updateRun(chatId, runId, { status: 'running', plan, connId })
  await notifyConnection(connId, { type: 'research_wave_start', runId, chatId, subQuestions: plan.subQuestions })
  console.log(JSON.stringify({ event: 'research_approve_started', runId, chatId }))
  return { statusCode: 200, body: '' }
}
