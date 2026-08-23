import type { ResearcherInput, ResearcherResult, Finding } from './types'
import { converseStream } from '../lib/bedrock'
import type { ModelSettings } from '../config/models'
import { safeParse } from '../lib/enrichment'
import type { ToolContext } from '../lib/tools'
import { notifyConnection } from '../lib/wsNotify'
import { stepEmitter } from './progress'
import { resolveRunModel } from './model'
import RESEARCH_RESEARCHER_SYSTEM_PROMPT from '../../prompts/research-researcher.txt'

// Only web_search/web_fetch — a researcher has no chat/memory/project context to draw on,
// just its one sub-question, so every other tool is switched off.
const RESEARCHER_SETTINGS: ModelSettings = {
  researchDepth: 'extended',
  webSearchEnabled: true,
  browserCoreEnabled: false,
  browserExtendedEnabled: false,
  memoryEnabled: false,
  searchEnabled: false,
  imageGenerationEnabled: false,
}

// Step Functions Task state inside the "Wave" Map state (terraform/research.tf,
// MaxConcurrency 3) — one bounded converseStream over a single sub-question, using the same
// tool-loop machinery ws/sendMessage.ts uses but with no WS connection: nothing streams,
// only the final JSON answer is read back.
export const handler = async (event: ResearcherInput): Promise<ResearcherResult> => {
  console.log(JSON.stringify({ event: 'research_researcher_start', runId: event.runId, subQuestionId: event.subQuestion.id }))

  const userMsg = [
    `SUB-QUESTION: ${event.subQuestion.question}`,
    ...(event.steeringNotes.length > 0 ? ['', 'STEERING NOTES FROM SUPERVISOR:', event.steeringNotes.join('\n')] : []),
  ].join('\n')

  const ctx: ToolContext = { sub: event.sub, chatId: event.chatId }

  // A researcher can spend minutes on multiple search/fetch rounds; without this its work
  // is invisible until the single research_finding frame at the very end.
  const emit = stepEmitter(event, event.subQuestion.id)

  const model = await resolveRunModel(event)

  let finalText = ''
  for await (const chunk of converseStream(
    model,
    RESEARCH_RESEARCHER_SYSTEM_PROMPT,
    [{ role: 'user', content: [{ kind: 'text', text: userMsg }] }],
    {
      settings: RESEARCHER_SETTINGS,
      ctx,
      call: { purpose: 'research_worker', sub: event.sub, chatId: event.chatId, runId: event.runId },
    },
  )) {
    await emit(chunk)
    if (chunk.type === 'turn' && chunk.role === 'assistant') {
      finalText = chunk.content.filter(b => b.kind === 'text').map(b => b.text).join('\n')
    }
  }

  // See docs/adr/0025-researcher-finding-plain-text-summary.md — still falls back to the
  // legacy nested-JSON shape for robustness against a model that ignores the format.
  const sourcesLine = /\nSOURCES:\s*(\[[\s\S]*\])\s*$/
  const match = finalText.match(sourcesLine)
  let finding: Finding
  if (match) {
    let sourceUrls: string[] = []
    try {
      const parsed = JSON.parse(match[1])
      if (Array.isArray(parsed)) sourceUrls = parsed.filter((u): u is string => typeof u === 'string')
    } catch {
      // leave sourceUrls empty — a malformed SOURCES array shouldn't drop the summary
    }
    finding = { subQuestionId: event.subQuestion.id, summary: finalText.slice(0, match.index).trim(), sourceUrls }
  } else {
    const obj = safeParse(finalText)
    finding = obj && typeof obj.summary === 'string'
      ? {
          subQuestionId: event.subQuestion.id,
          summary: obj.summary,
          sourceUrls: Array.isArray(obj.sourceUrls) ? obj.sourceUrls.filter((u): u is string => typeof u === 'string') : [],
        }
      : { subQuestionId: event.subQuestion.id, summary: finalText, sourceUrls: [] }
  }

  console.log(JSON.stringify({ event: 'research_researcher_done', runId: event.runId, subQuestionId: event.subQuestion.id, sourceCount: finding.sourceUrls.length }))
  await notifyConnection(event.connId, {
    type: 'research_finding',
    runId: event.runId,
    chatId: event.chatId,
    subQuestionId: finding.subQuestionId,
    summary: finding.summary,
    sourceUrls: finding.sourceUrls,
  })
  return { finding }
}
