import type { PlanInput, PlanResult, SubQuestion } from './types'
import { converseOnce } from '../lib/bedrock'
import { DEFAULT_CHAT_MODEL } from '../config/models'
import { safeParse } from '../lib/enrichment'
import { newId } from '../lib/ids'
import RESEARCH_PLAN_SYSTEM_PROMPT from '../../prompts/research-plan.txt'

interface RawSubQuestion {
  id?: unknown
  question?: unknown
}

// Step Functions Task state "Plan" (terraform/research.tf) — proposes clarifying
// questions and sub-questions from the question + Recon's notes; shown in chat and
// blocks on user approval (the following "AwaitApproval" state).
export const handler = async (event: PlanInput): Promise<PlanResult> => {
  console.log(JSON.stringify({ event: 'research_plan_start', runId: event.runId, chatId: event.chatId }))

  const userMsg = [
    `QUESTION: ${event.question}`,
    ``,
    `RECON NOTES:`,
    event.recon.notes.length > 0 ? event.recon.notes.join('\n\n') : '(none)',
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
  return { subQuestions, clarifyingQuestions }
}
