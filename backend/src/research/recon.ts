import type { ReconInput, ReconResult } from './types'

// Step Functions Task state "Recon" (terraform/research.tf) — one or two cheap searches
// to find out what the question actually involves, before Plan drafts sub-questions
// against something more grounded than the raw question. Stubbed until task #10.
export const handler = async (event: ReconInput): Promise<ReconResult> => {
  console.log(JSON.stringify({ event: 'research_recon_start', runId: event.runId, chatId: event.chatId }))
  return { notes: [] }
}
