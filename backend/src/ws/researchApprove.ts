import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn'
import { getConnection, getRun, updateRun } from '../lib/dynamo'
import { notifyConnection } from '../lib/wsNotify'

const sfn = new SFNClient({})

interface WSEvent {
  requestContext: { connectionId: string }
  body?: string
}

interface ApproveBody {
  chatId: string
  runId: string
  action: 'approve' | 'revise'
  // Freetext feedback. Required for "revise" (drives a Replan). Optional for "approve" —
  // if present it's folded in as steering for the first wave instead of triggering a
  // replan, per the plan's "approve, or revise, or go from there" design.
  feedback?: string
}

// WS action "researchApprove" — resolves the task token `AwaitApproval` (terraform/
// research.tf) is blocked on, via `.waitForTaskToken`'s SendTaskSuccess. There is no
// "reject": a user who doesn't like the plan just abandons the chat, and AwaitApproval's
// 24h TimeoutSeconds fails the run cleanly on its own — cleanup doesn't need a button.
// AwaitApproval has no ResultPath, so a successful SendTaskSuccess payload entirely
// replaces the state machine's state ($) — it must reconstruct every field the rest of
// the pipeline (ApprovalChoice/Replan/Wave/Assess/Report) needs, not just the plan.
export const handler = async (event: WSEvent): Promise<APIGatewayProxyResultV2> => {
  const connId = event.requestContext.connectionId
  const conn = await getConnection(connId)
  if (!conn) return { statusCode: 410, body: 'Gone' }

  const body = JSON.parse(event.body ?? '{}') as ApproveBody
  const { chatId, runId, action, feedback } = body

  const run = await getRun(chatId, runId)
  if (!run || run.sub !== conn.userSub) return { statusCode: 404, body: 'Not found' }
  if (run.status !== 'awaiting_approval' || !run.taskToken) return { statusCode: 409, body: 'Not awaiting approval' }

  if (action === 'revise') {
    const trimmed = feedback?.trim()
    if (!trimmed) return { statusCode: 400, body: 'feedback is required to revise' }

    await sfn.send(new SendTaskSuccessCommand({
      taskToken: run.taskToken,
      output: JSON.stringify({
        chatId,
        runId,
        sub: run.sub,
        question: run.question,
        plan: run.plan,
        feedback: trimmed,
        revise: true,
        connId,
      }),
    }))
    // status stays 'awaiting_approval' — ApprovalChoice/Replan loop back into a fresh
    // AwaitApproval visit. Refresh connId in case the user reconnected from another tab.
    await updateRun(chatId, runId, { connId })
    console.log(JSON.stringify({ event: 'research_approve_revise', runId, chatId }))
    return { statusCode: 200, body: '' }
  }

  const plan = run.plan
  const steeringNotes = feedback?.trim() ? [feedback.trim()] : []
  await sfn.send(new SendTaskSuccessCommand({
    taskToken: run.taskToken,
    output: JSON.stringify({
      chatId,
      runId,
      sub: run.sub,
      question: run.question,
      plan,
      findings: [],
      nextSubQuestions: plan?.subQuestions ?? [],
      gapsNotPursued: [],
      steeringNotes,
      roundsSpent: 0,
      // The approving connection, not necessarily the one that started the run — refreshes
      // where Wave/Assess push progress frames if the user reconnected from another tab.
      connId,
    }),
  }))
  await updateRun(chatId, runId, { status: 'running', plan, connId })
  await notifyConnection(connId, { type: 'research_wave_start', runId, chatId, subQuestions: plan?.subQuestions ?? [] })
  console.log(JSON.stringify({ event: 'research_approve_started', runId, chatId }))
  return { statusCode: 200, body: '' }
}
