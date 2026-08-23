import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn'
import { getRun, updateRun } from './dynamo'
import { notifyConnection } from './wsNotify'

const sfn = new SFNClient({})

// Resolving the plan-approval gate: the task token `AwaitApproval` (terraform/research.tf)
// is blocked on, released via `.waitForTaskToken`'s SendTaskSuccess. Two callers reach this:
// the `researchApprove` WS action (the panel's Approve button) and `ws/sendMessage.ts` (a
// reply typed into the main composer) — see docs/adr/0032-plan-feedback-classified-by-a-tiny-model.md.
//
// AwaitApproval has no ResultPath, so a successful SendTaskSuccess payload entirely
// replaces the state machine's state ($) — it must reconstruct every field the rest of
// the pipeline (ApprovalChoice/Replan/Wave/Assess/Report) needs, not just the plan.
// A revise loops AwaitApproval -> Replan -> AwaitApproval, minting a fresh task token.
// Both decisions move the run out of 'awaiting_approval' immediately, so the panel stops
// offering the button and a second decision hits the status guard — but the status write
// lands just after SendTaskSuccess, so retry against a freshly re-read row on a stale-token
// error anyway, for a decision that arrives inside that window.
const STALE_TOKEN_RETRY_DELAYS_MS = [300, 600, 1000, 1500]

function isStaleTaskTokenError(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name
  return name === 'TaskTimedOut' || name === 'TaskDoesNotExist'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export type ApprovalOutcome = 'started' | 'revising' | 'not_awaiting' | 'not_found'

export async function resolvePlanApproval(params: {
  chatId: string
  runId: string
  connId: string
  // The already-read RUN# row, so a caller that has one doesn't pay for a second GetItem.
  run: Record<string, unknown>
  decision: 'approve' | 'revise'
  // Carried into the first wave as a steering note on approve; drives the Replan on revise.
  feedback?: string
}): Promise<ApprovalOutcome> {
  const { chatId, runId, connId, decision } = params
  let run = params.run
  const feedback = params.feedback?.trim()
  if (decision === 'revise' && !feedback) return 'not_awaiting'

  for (let attempt = 0; ; attempt++) {
    if (run.status !== 'awaiting_approval' || !run.taskToken) return 'not_awaiting'

    try {
      if (decision === 'revise') {
        await sfn.send(new SendTaskSuccessCommand({
          taskToken: run.taskToken as string,
          output: JSON.stringify({
            chatId,
            runId,
            sub: run.sub,
            question: run.question,
            plan: run.plan,
            feedback,
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
        return 'revising'
      }

      const plan = run.plan as { subQuestions?: unknown[] } | undefined
      await sfn.send(new SendTaskSuccessCommand({
        taskToken: run.taskToken as string,
        output: JSON.stringify({
          chatId,
          runId,
          sub: run.sub,
          question: run.question,
          plan,
          findings: [],
          nextSubQuestions: plan?.subQuestions ?? [],
          gapsNotPursued: [],
          steeringNotes: feedback ? [feedback] : [],
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
      return 'started'
    } catch (err) {
      if (!isStaleTaskTokenError(err) || attempt >= STALE_TOKEN_RETRY_DELAYS_MS.length) throw err
      console.log(JSON.stringify({ event: 'research_approve_stale_token_retry', runId, chatId, attempt }))
      await sleep(STALE_TOKEN_RETRY_DELAYS_MS[attempt])
      const fresh = await getRun(chatId, runId)
      if (!fresh) return 'not_found'
      run = fresh
    }
  }
}
