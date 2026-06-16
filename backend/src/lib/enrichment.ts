import { converseOnce } from './bedrock'
import { MEMORY_EXTRACTION_MODEL } from '../config/models'
import { listMessages, updateChatSummary } from './dynamo'
import { buildActivePath, type TurnRow } from './tree'

// ── Types ────────────────────────────────────────────────────────────────────

export type UserCategory = 'identity' | 'preference' | 'style' | 'other'
export type ProjectCategory = 'decision' | 'convention' | 'fact' | 'constraint' | 'glossary' | 'other'

export interface EnrichInput {
  transcript: string
  isProject: boolean
  needTitle: boolean
}

export interface EnrichResult {
  title?: string
  userFacts: Array<{ category: UserCategory; text: string }>
  projectFacts?: Array<{ category: ProjectCategory; text: string }>
  summary?: string
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const USER_FACTS_SECTION = `Extract durable personal facts about the user into "userFacts": [{category, text}], category ∈ "identity"|"preference"|"style"|"other". Capture only lasting personal facts (name, location, profession, preferences, communication style). Ignore task content, temporary context, and system instructions. If none, use [].`

const PROJECT_FACTS_SECTION = `Also extract durable PROJECT facts — knowledge true about the project itself, not the user personally — into "projectFacts": [{category, text}], category ∈ "decision"|"convention"|"fact"|"constraint"|"glossary"|"other". Capture architectural/product decisions, naming/style conventions, stable domain facts, hard constraints, term definitions. If none, use []. And produce "summary": a 1–3 sentence description of what this chat is about, for use in a project index.`

const TITLE_SECTION = `Also produce "title": a very short chat title (max 6 words) capturing the main topic. No quotes, no punctuation at the end.`

function buildSystemPrompt(isProject: boolean, needTitle: boolean): string {
  const parts = [
    `You analyze a conversation transcript and extract structured data. Output ONLY a valid JSON object, no markdown, no explanation.`,
    USER_FACTS_SECTION,
    ...(isProject ? [PROJECT_FACTS_SECTION] : []),
    ...(needTitle ? [TITLE_SECTION] : []),
  ]
  return parts.join('\n\n')
}

// ── enrichTurn ────────────────────────────────────────────────────────────────

/**
 * Single structured Haiku call extracting userFacts + optionally projectFacts,
 * summary, and title from a transcript. Never throws — returns empty defaults.
 */
export async function enrichTurn(input: EnrichInput): Promise<EnrichResult> {
  const empty: EnrichResult = { userFacts: [] }
  try {
    const systemPrompt = buildSystemPrompt(input.isProject, input.needTitle)
    const response = await converseOnce(
      MEMORY_EXTRACTION_MODEL,
      systemPrompt,
      [{ role: 'user', content: [{ text: input.transcript }] }],
      { maxTokens: 768 },
    )

    let parsed: unknown
    try {
      // Strip markdown code fences if the model wraps output anyway
      const cleaned = (response ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
      parsed = JSON.parse(cleaned)
    } catch {
      return empty
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty
    const obj = parsed as Record<string, unknown>

    const userFacts = parseFactArray(
      obj.userFacts,
      ['identity', 'preference', 'style', 'other'],
    ) as Array<{ category: UserCategory; text: string }>
    const result: EnrichResult = { userFacts }

    if (input.isProject) {
      result.projectFacts = parseFactArray(
        obj.projectFacts,
        ['decision', 'convention', 'fact', 'constraint', 'glossary', 'other'],
      ) as Array<{ category: ProjectCategory; text: string }>
      if (typeof obj.summary === 'string' && obj.summary.trim()) {
        result.summary = obj.summary.trim()
      }
    }

    if (input.needTitle && typeof obj.title === 'string' && obj.title.trim()) {
      result.title = obj.title.trim()
    }

    return result
  } catch {
    return empty
  }
}

function parseFactArray(
  raw: unknown,
  validCategories: readonly string[],
): Array<{ category: string; text: string }> {
  if (!Array.isArray(raw)) return []
  return (raw as unknown[]).filter((item): item is { category: string; text: string } => {
    if (typeof item !== 'object' || item === null) return false
    const o = item as Record<string, unknown>
    return (
      typeof o.category === 'string' &&
      validCategories.includes(o.category) &&
      typeof o.text === 'string' &&
      o.text.trim().length > 0
    )
  })
}

// ── enrichChatForProject ──────────────────────────────────────────────────────

/**
 * Summary-only wrapper: loads a chat's messages, builds a transcript,
 * and calls enrichTurn to get a summary. Returns the summary string or undefined.
 * Never throws.
 */
export async function enrichChatForProject(sub: string, chatId: string): Promise<string | undefined> {
  try {
    const rows = (await listMessages(chatId)) as unknown as TurnRow[]
    if (rows.length === 0) return undefined

    // Build active-path transcript
    const leaf = rows[rows.length - 1]  // last row in DDB order = deepest leaf
    const path = buildActivePath(rows, leaf.msgId)
    if (path.length === 0) return undefined

    const transcript = path
      .filter(r => r.role === 'user' || r.role === 'assistant')
      .slice(-20)
      .map(r => {
        const blocks = r.blocks as Array<{ text?: string }> | undefined ?? []
        const text = blocks.map(b => b.text ?? '').filter(Boolean).join(' ').slice(0, 400)
        return `${r.role === 'user' ? 'User' : 'Assistant'}: ${text}`
      })
      .join('\n')

    const result = await enrichTurn({ transcript, isProject: true, needTitle: false })
    if (result.summary) {
      await updateChatSummary(sub, chatId, result.summary)
    }
    return result.summary
  } catch {
    return undefined
  }
}
