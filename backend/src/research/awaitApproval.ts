import type { AwaitApprovalInput } from './types'

// Step Functions Task state "AwaitApproval" (terraform/research.tf), integration pattern
// `.waitForTaskToken` — the ASL Parameters block injects `$$.Task.Token` into `taskToken`.
// Returning from this handler does NOT complete the state; only a later
// SendTaskSuccess/SendTaskFailure call against that token does (task #11: the WS
// `researchApprove` action, once the user edits/approves the plan). This handler's only
// job is to persist the token (and the plan it belongs to) somewhere the approve handler
// can find it — stubbed until the RUN# row exists (#9).
export const handler = async (event: AwaitApprovalInput): Promise<void> => {
  console.log(JSON.stringify({ event: 'research_await_approval_start', runId: event.runId, chatId: event.chatId }))
}
