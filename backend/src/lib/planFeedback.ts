import { converseOnce } from './bedrock'
import { TINY_MODEL } from '../config/models'
import type { PlanResult } from '../research/types'

// What the user's reply to a proposed research plan actually means. Three outcomes because
// the approval gate has three: start as-is, start with the reply carried into the wave as a
// steering note, or replan first.
// See docs/adr/0032-plan-feedback-classified-by-a-tiny-model.md.
export type PlanFeedbackDecision = 'approve' | 'approve_with_steering' | 'revise'

const SYSTEM_PROMPT = `You classify a user's reply to a proposed research plan. Answer with exactly one word, nothing else:

APPROVE — the reply is bare consent with no instruction ("ok", "looks good", "go ahead").
STEER — the reply consents but adds guidance that does not change which sub-questions get researched (e.g. "go ahead, prefer primary sources", "yes, and keep it brief").
REVISE — the reply asks for the plan itself to change, answers a clarifying question, adds or removes scope, corrects a misunderstanding, or asks a question of its own.

When it is not clearly APPROVE or STEER, answer REVISE.`

function renderPlan(plan: PlanResult | undefined): string {
  if (!plan) return '(no plan)'
  const clarifying = plan.clarifyingQuestions.length > 0
    ? `Clarifying questions:\n${plan.clarifyingQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n`
    : ''
  return `${clarifying}Sub-questions:\n${plan.subQuestions.map((sq, i) => `${i + 1}. ${sq.question}`).join('\n')}`
}

/**
 * Classify a plan-approval reply that arrived through the main composer.
 * Never throws — falls back to 'revise', the only recoverable answer: a needless replan
 * costs one round and the user sees the plan again, whereas starting a wave on a
 * misread instruction cannot be taken back.
 */
export async function classifyPlanFeedback(
  feedback: string,
  plan: PlanResult | undefined,
  ctx: { sub?: string; chatId?: string; runId?: string },
): Promise<PlanFeedbackDecision> {
  try {
    const response = await converseOnce(
      TINY_MODEL,
      SYSTEM_PROMPT,
      [{ role: 'user', content: [{ kind: 'text', text: `PROPOSED PLAN:\n${renderPlan(plan)}\n\nUSER REPLY:\n${feedback}` }] }],
      { maxTokens: 8, call: { purpose: 'research_plan_feedback', ...ctx } },
    )
    const verdict = response.trim().toUpperCase()
    if (verdict.startsWith('APPROVE')) return 'approve'
    if (verdict.startsWith('STEER')) return 'approve_with_steering'
    if (verdict.startsWith('REVISE')) return 'revise'
    console.error(JSON.stringify({ event: 'plan_feedback_unparsed', ...ctx, response: response.slice(0, 100) }))
    return 'revise'
  } catch (err) {
    console.error(JSON.stringify({ event: 'plan_feedback_classify_error', ...ctx, error: String(err) }))
    return 'revise'
  }
}
