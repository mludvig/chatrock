import type { ResearcherInput, ResearcherResult, Finding } from './types'
import { converseStream } from '../lib/bedrock'
import type { ModelSettings } from '../config/models'
import { DEFAULT_CHAT_MODEL } from '../config/models'
import { safeParse } from '../lib/enrichment'
import type { ToolContext } from '../lib/tools'
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

  let finalText = ''
  for await (const chunk of converseStream(
    DEFAULT_CHAT_MODEL,
    RESEARCH_RESEARCHER_SYSTEM_PROMPT,
    [{ role: 'user', content: [{ kind: 'text', text: userMsg }] }],
    RESEARCHER_SETTINGS,
    ctx,
  )) {
    if (chunk.type === 'turn' && chunk.role === 'assistant') {
      finalText = chunk.content.filter(b => b.kind === 'text').map(b => b.text).join('\n')
    }
  }

  const obj = safeParse(finalText)
  const finding: Finding = obj && typeof obj.summary === 'string'
    ? {
        subQuestionId: event.subQuestion.id,
        summary: obj.summary,
        sourceUrls: Array.isArray(obj.sourceUrls) ? obj.sourceUrls.filter((u): u is string => typeof u === 'string') : [],
      }
    : { subQuestionId: event.subQuestion.id, summary: finalText, sourceUrls: [] }

  console.log(JSON.stringify({ event: 'research_researcher_done', runId: event.runId, subQuestionId: event.subQuestion.id, sourceCount: finding.sourceUrls.length }))
  return { finding }
}
