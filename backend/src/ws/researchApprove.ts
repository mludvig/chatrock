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
  // Named "decision", not "action" — the WS envelope's own `action: 'researchApprove'`
  // is what API Gateway's route_selection_expression ($request.body.action) matches on
  // (terraform/apigw_ws.tf); reusing that key here would collide with routing.
  decision: 'approve' | 'revise'
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
// A revise loops AwaitApproval -> Replan -> AwaitApproval, minting a fresh task token.
// Both decisions move the run out of 'awaiting_approval' immediately (below), so the
// panel stops offering the button and a second decision hits the status guard — but the
// status write lands just after SendTaskSuccess, so retry against a freshly re-read row
// on a stale-token error anyway, for a decision that arrives inside that window.
const STALE_TOKEN_RETRY_DELAYS_MS = [300, 600, 1000, 1500]

function isStaleTaskTokenError(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name
  return name === 'TaskTimedOut' || name === 'TaskDoesNotExist'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export const handler = async (event: WSEvent): Promise<APIGatewayProxyResultV2> => {
  const connId = event.requestContext.connectionId
  const conn = await getConnection(connId)
  if (!conn) return { statusCode: 410, body: 'Gone' }

  const body = JSON.parse(event.body ?? '{}') as ApproveBody
  const { chatId, runId, decision, feedback } = body

  if (decision === 'revise') {
    const trimmed = feedback?.trim()
    if (!trimmed) return { statusCode: 400, body: 'feedback is required to revise' }
  }

  let run = await getRun(chatId, runId)
  if (!run || run.sub !== conn.userSub) return { statusCode: 404, body: 'Not found' }

  for (let attempt = 0; ; attempt++) {
    if (run.status !== 'awaiting_approval' || !run.taskToken) return { statusCode: 409, body: 'Not awaiting approval' }

    try {
      if (decision === 'revise') {
        const trimmed = (feedback as string).trim()
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
        // The run is planning again until Replan's fresh AwaitApproval visit writes
        // 'awaiting_approval' back (awaitApproval.ts) — saying so here is what stops the
        // panel from re-offering the superseded plan, and makes a second decision arriving
        // in the meantime fail the guard above instead of racing the token rotation.
        // Refresh connId in case the user reconnected from another tab.
        await updateRun(chatId, runId, { connId, status: 'planning' })
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
          // ApprovalChoice's Variable path ($.revise) throws States.Runtime if the field is
          // absent entirely (not merely falsy) — must be explicit here, not just omitted.
          revise: false,
          // The approving connection, not necessarily the one that started the run —
          // refreshes where Wave/Assess push progress frames if the user reconnected from
          // another tab.
          connId,
        }),
      }))
      await updateRun(chatId, runId, { status: 'running', plan, connId })
      await notifyConnection(connId, { type: 'research_wave_start', runId, chatId, subQuestions: plan?.subQuestions ?? [] })
      console.log(JSON.stringify({ event: 'research_approve_started', runId, chatId }))
      return { statusCode: 200, body: '' }
    } catch (err) {
      if (!isStaleTaskTokenError(err) || attempt >= STALE_TOKEN_RETRY_DELAYS_MS.length) throw err
      console.log(JSON.stringify({ event: 'research_approve_stale_token_retry', runId, chatId, attempt }))
      await sleep(STALE_TOKEN_RETRY_DELAYS_MS[attempt])
      const fresh = await getRun(chatId, runId)
      if (!fresh) return { statusCode: 404, body: 'Not found' }
      run = fresh
    }
  }
}
