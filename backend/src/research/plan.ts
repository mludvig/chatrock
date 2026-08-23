import type { PlanInput, PlanResult, SubQuestion } from './types'
import { converseOnce } from '../lib/bedrock'
import { safeParse } from '../lib/enrichment'
import { newId } from '../lib/ids'
import { notifyPhase } from './progress'
import { resolveRunModel } from './model'
import { resolveRunContext } from './context'
import RESEARCH_PLAN_SYSTEM_PROMPT from '../../prompts/research-plan.txt'

interface RawSubQuestion {
  id?: unknown
  question?: unknown
}

// Numbered rather than raw JSON so a "#1 I meant xyz" reply lands on the same item the
// user was looking at — ResearchPanel.tsx numbers both lists the same way. Ids are kept
// visible so unchanged sub-questions can keep theirs.
function renderPlanForFeedback(plan: PlanResult): string {
  const clarifying = plan.clarifyingQuestions.length > 0
    ? `CLARIFYING QUESTIONS:\n${plan.clarifyingQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n`
    : ''
  return `${clarifying}SUB-QUESTIONS:\n${plan.subQuestions.map((sq, i) => `${i + 1}. [id: ${sq.id}] ${sq.question}`).join('\n')}`
}

// Step Functions Task state "Plan" and "Replan" (terraform/research.tf) share this
// handler. "Plan" proposes clarifying questions and sub-questions from the question +
// Recon's notes; "Replan" runs when the user hits "Revise" on the approval gate
// (event.priorPlan/event.feedback set instead of event.recon) and produces an updated
// plan from the same free-text feedback. Either way the result is shown in chat and
// blocks on user approval (the "AwaitApproval" state).
export const handler = async (event: PlanInput): Promise<PlanResult> => {
  console.log(JSON.stringify({ event: 'research_plan_start', runId: event.runId, chatId: event.chatId, revise: !!event.priorPlan }))
  await notifyPhase(event, 'planning', event.priorPlan ? 'Revising the plan' : undefined)

  // The planner is the only stage that sees the user's memory: it resolves the ambiguities
  // that would otherwise become clarifying questions, and writes what it learned into the
  // sub-questions themselves, since a researcher has no user context of its own.
  // See docs/adr/0033-research-runs-see-the-users-memory.md.
  const context = await resolveRunContext(event)
  const preamble = context ? [`ABOUT THE USER:`, context, ``] : []

  const userMsg = [...preamble, ...(event.priorPlan
    ? [
        `QUESTION: ${event.question}`,
        ``,
        `CURRENT PLAN (numbered exactly as the user saw it — feedback like "#2" refers to`,
        `these numbers, counted separately within each list):`,
        renderPlanForFeedback(event.priorPlan),
        ``,
        `USER FEEDBACK ON THE PLAN: ${event.feedback}`,
        ``,
        `Revise the plan to address the feedback.`,
      ]
    : [
        `QUESTION: ${event.question}`,
        ``,
        `RECON NOTES:`,
        event.recon && event.recon.notes.length > 0 ? event.recon.notes.join('\n\n') : '(none)',
      ])].join('\n')

  const model = await resolveRunModel(event)
  const response = await converseOnce(model, RESEARCH_PLAN_SYSTEM_PROMPT, [
    { role: 'user', content: [{ kind: 'text', text: userMsg }] },
  ], { maxTokens: 1536, call: { purpose: 'research_plan', sub: event.sub, chatId: event.chatId, runId: event.runId } })

  const obj = safeParse(response)
  if (!obj) {
    console.error(JSON.stringify({ event: 'research_plan_parse_error', runId: event.runId, chatId: event.chatId, response: response?.slice(0, 500) }))
    return { subQuestions: [], clarifyingQuestions: [] }
  }

  const seenIds = new Set<string>()
  const rawSubQuestions = Array.isArray(obj.subQuestions) ? (obj.subQuestions as RawSubQuestion[]) : []
  const subQuestions: SubQuestion[] = rawSubQuestions
    .filter((sq): sq is { id?: unknown; question: string } => typeof sq.question === 'string' && sq.question.trim().length > 0)
    .map(sq => {
      let id = typeof sq.id === 'string' && sq.id.trim() ? sq.id.trim() : newId()
      if (seenIds.has(id)) id = newId()
      seenIds.add(id)
      return { id, question: sq.question.trim() }
    })

  const clarifyingQuestions = Array.isArray(obj.clarifyingQuestions)
    ? obj.clarifyingQuestions.filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
    : []

  // The `research_plan` frame is pushed by awaitApproval.ts, not here — it announces a plan
  // the client can reload into the transcript, so it waits until the turn is persisted.
  console.log(JSON.stringify({ event: 'research_plan_done', runId: event.runId, chatId: event.chatId, subQuestionCount: subQuestions.length, clarifyingCount: clarifyingQuestions.length }))
  return { subQuestions, clarifyingQuestions }
}
