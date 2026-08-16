import type { PlanInput, PlanResult, SubQuestion } from './types'
import { converseOnce } from '../lib/bedrock'
import { DEFAULT_CHAT_MODEL } from '../config/models'
import { safeParse } from '../lib/enrichment'
import { newId } from '../lib/ids'
import { notifyConnection } from '../lib/wsNotify'
import RESEARCH_PLAN_SYSTEM_PROMPT from '../../prompts/research-plan.txt'

interface RawSubQuestion {
  id?: unknown
  question?: unknown
}

// Step Functions Task state "Plan" and "Replan" (terraform/research.tf) share this
// handler. "Plan" proposes clarifying questions and sub-questions from the question +
// Recon's notes; "Replan" runs when the user hits "Revise" on the approval gate
// (event.priorPlan/event.feedback set instead of event.recon) and produces an updated
// plan from the same free-text feedback. Either way the result is shown in chat and
// blocks on user approval (the "AwaitApproval" state).
export const handler = async (event: PlanInput): Promise<PlanResult> => {
  console.log(JSON.stringify({ event: 'research_plan_start', runId: event.runId, chatId: event.chatId, revise: !!event.priorPlan }))

  const userMsg = event.priorPlan
    ? [
        `QUESTION: ${event.question}`,
        ``,
        `CURRENT PLAN:`,
        JSON.stringify(event.priorPlan),
        ``,
        `USER FEEDBACK ON THE PLAN: ${event.feedback}`,
        ``,
        `Revise the plan to address the feedback.`,
      ].join('\n')
    : [
        `QUESTION: ${event.question}`,
        ``,
        `RECON NOTES:`,
        event.recon && event.recon.notes.length > 0 ? event.recon.notes.join('\n\n') : '(none)',
      ].join('\n')

  const response = await converseOnce(DEFAULT_CHAT_MODEL, RESEARCH_PLAN_SYSTEM_PROMPT, [
    { role: 'user', content: [{ kind: 'text', text: userMsg }] },
  ])

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

  console.log(JSON.stringify({ event: 'research_plan_done', runId: event.runId, chatId: event.chatId, subQuestionCount: subQuestions.length, clarifyingCount: clarifyingQuestions.length }))
  await notifyConnection(event.connId, { type: 'research_plan', runId: event.runId, chatId: event.chatId, plan: { subQuestions, clarifyingQuestions } })
  return { subQuestions, clarifyingQuestions }
}
