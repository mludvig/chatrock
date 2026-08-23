import type { AwaitApprovalInput, PlanResult } from './types'
import { v4 as uuidv4 } from 'uuid'
import { updateRun, getChat, putMessage, buildTurnKey, updateChatActiveLeaf } from '../lib/dynamo'
import { notifyConnection } from '../lib/wsNotify'
import { resolveRunModel } from './model'

// Numbered exactly as the panel's clarifying-question list and the Replan prompt number
// them, so "#1 I mean xyz" means the same thing in all three.
function renderPlan(plan: PlanResult): string {
  const clarifying = plan.clarifyingQuestions.length > 0
    ? `**Before I start — a few questions:**\n\n${plan.clarifyingQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n`
    : ''
  const subQuestions = plan.subQuestions.map((sq, i) => `${i + 1}. ${sq.question}`).join('\n')
  return `${clarifying}**Proposed research plan**\n\n${subQuestions}`
}

// Step Functions Task state "AwaitApproval" (terraform/research.tf), integration pattern
// `.waitForTaskToken` — the ASL Parameters block injects `$$.Task.Token` into `taskToken`.
// Returning from this handler does NOT complete the state; only a later
// SendTaskSuccess/SendTaskFailure call against that token does (lib/researchApproval.ts,
// reached from the panel's Approve button or a composer reply). This handler persists
// everything that call needs to find and resolve the run — `updateRun` upserts the RUN#
// row, since this is its first write.
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

  // The plan is a normal assistant turn, not panel-only state: the user answers it in the
  // composer, so it has to stay in the transcript above their reply the way any other
  // question they answered does — and survive the reload, and a Replan's second version
  // alongside the first. `research_plan` is pushed from here rather than from plan.ts so
  // the client only learns of a plan that is already durable.
  // See docs/adr/0032-plan-feedback-classified-by-a-tiny-model.md.
  const model = await resolveRunModel(event)
  const chat = await getChat(event.sub, event.chatId)
  const ts = new Date().toISOString()
  const msgId = uuidv4()
  await putMessage({
    ...buildTurnKey(event.chatId, ts, 0, msgId),
    msgId,
    parentId: (chat?.activeLeafId as string | undefined) ?? null,
    role: 'assistant',
    blocks: [{ kind: 'text', text: renderPlan(event.plan) }],
    model,
    createdAt: ts,
    turnIndex: 0,
    responseId: uuidv4(),
  })
  await updateChatActiveLeaf(event.sub, event.chatId, msgId)

  await notifyConnection(event.connId, {
    type: 'research_plan', runId: event.runId, chatId: event.chatId, plan: event.plan, msgId,
  })
}
