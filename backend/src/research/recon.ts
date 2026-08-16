import type { ReconInput, ReconResult } from './types'
import { executeTool } from '../lib/tools'

// Step Functions Task state "Recon" (terraform/research.tf) — one cheap web_search to find
// out what the question actually involves, before Plan drafts sub-questions against
// something more grounded than the raw question.
export const handler = async (event: ReconInput): Promise<ReconResult> => {
  console.log(JSON.stringify({ event: 'research_recon_start', runId: event.runId, chatId: event.chatId }))

  const result = await executeTool('web_search', { query: event.question }, { sub: event.sub, chatId: event.chatId })
  const notes = result.isError
    ? []
    : result.entries.filter((e): e is { kind: 'text'; text: string } => e.kind === 'text').map(e => e.text)

  console.log(JSON.stringify({ event: 'research_recon_done', runId: event.runId, chatId: event.chatId, noteCount: notes.length }))
  return { notes }
}
