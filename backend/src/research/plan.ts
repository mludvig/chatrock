import type { PlanInput, PlanResult } from './types'

// Step Functions Task state "Plan" (terraform/research.tf) — proposes clarifying
// questions and sub-questions from the question + Recon's notes; shown in chat and
// blocks on user approval (the following "AwaitApproval" state). Stubbed until #10.
export const handler = async (event: PlanInput): Promise<PlanResult> => {
  console.log(JSON.stringify({ event: 'research_plan_start', runId: event.runId, chatId: event.chatId }))
  return { subQuestions: [], clarifyingQuestions: [] }
}
