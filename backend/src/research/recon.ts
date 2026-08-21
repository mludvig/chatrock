import type { ReconInput, ReconResult } from './types'
import { executeTool } from '../lib/tools'
import { newId } from '../lib/ids'
import { notifyPhase, notifyStep } from './progress'

// Step Functions Task state "Recon" (terraform/research.tf) — one cheap web_search to find
// out what the question actually involves, before Plan drafts sub-questions against
// something more grounded than the raw question.
export const handler = async (event: ReconInput): Promise<ReconResult> => {
  console.log(JSON.stringify({ event: 'research_recon_start', runId: event.runId, chatId: event.chatId }))

  // This is a bare executeTool call rather than a converseStream loop, so there are no
  // chunks for progress.ts's stepEmitter to translate — the pending/resolved pair is
  // emitted directly instead, through the same notifyStep the emitter itself uses.
  await notifyPhase(event, 'recon')
  const toolUseId = newId()
  const input = JSON.stringify({ query: event.question })
  await notifyStep(event, { kind: 'tool', toolUseId, name: 'web_search', input })

  const result = await executeTool('web_search', { query: event.question }, { sub: event.sub, chatId: event.chatId })
  const notes = result.isError
    ? []
    : result.entries.filter((e): e is { kind: 'text'; text: string } => e.kind === 'text').map(e => e.text)

  await notifyStep(event, {
    kind: 'tool',
    toolUseId,
    name: 'web_search',
    input,
    result: notes.join('\n').slice(0, 2000),
    isError: result.isError,
  })

  console.log(JSON.stringify({ event: 'research_recon_done', runId: event.runId, chatId: event.chatId, noteCount: notes.length }))
  return { notes }
}
