import type { ResearcherInput, ResearcherResult } from './types'

// Step Functions Task state inside the "Wave" Map state (terraform/research.tf,
// MaxConcurrency 3) — one bounded converseStream over a single sub-question. Stubbed
// until #12, which wires this to lib/llm/loop.ts the same way ws/sendMessage.ts does,
// just without a WS connection to stream deltas to.
export const handler = async (event: ResearcherInput): Promise<ResearcherResult> => {
  console.log(JSON.stringify({ event: 'research_researcher_start', runId: event.runId, subQuestionId: event.subQuestion.id }))
  return { finding: { subQuestionId: event.subQuestion.id, summary: '', sourceUrls: [] } }
}
