import type { AwaitApprovalInput } from './types'
import { updateRun } from '../lib/dynamo'

// Step Functions Task state "AwaitApproval" (terraform/research.tf), integration pattern
// `.waitForTaskToken` — the ASL Parameters block injects `$$.Task.Token` into `taskToken`.
// Returning from this handler does NOT complete the state; only a later
// SendTaskSuccess/SendTaskFailure call against that token does (the WS `researchApprove`
// action, in ws/researchApprove.ts, once the user edits/approves the plan). This handler's
// only job is to persist everything that call needs to find and resolve the run —
// `updateRun` upserts the RUN# row, since this is its first write.
export const handler = async (event: AwaitApprovalInput): Promise<void> => {
  console.log(JSON.stringify({ event: 'research_await_approval_start', runId: event.runId, chatId: event.chatId }))

  await updateRun(event.chatId, event.runId, {
    runId: event.runId,
    chatId: event.chatId,
    sub: event.sub,
    status: 'awaiting_approval',
    question: event.question,
    plan: event.plan,
    taskToken: event.taskToken,
    findings: [],
    gapsNotPursued: [],
    steeringNotes: [],
    roundsSpent: 0,
  })
}
