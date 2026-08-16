import type { AssessInput, AssessResult } from './types'

// Step Functions Task state "Assess" (terraform/research.tf) — the supervisor reads all
// findings so far plus any pending steering notes and decides whether to stop (-> Report)
// or spend another Wave on specific gaps. No fixed round limit (the ask was an
// open-ended budget); `roundsSpent` feeds a hard backstop cap enforced by the ASL Choice
// state, not by this handler. Stubbed until #13.
export const handler = async (event: AssessInput): Promise<AssessResult> => {
  console.log(JSON.stringify({ event: 'research_assess_start', runId: event.runId, roundsSpent: event.roundsSpent }))
  return { done: true, nextSubQuestions: [], gapsNotPursued: [] }
}
