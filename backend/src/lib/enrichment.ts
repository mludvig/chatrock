import { converseOnce } from './bedrock'
import { MEMORY_EXTRACTION_MODEL } from '../config/models'
import { listMessages, updateChatSummary } from './dynamo'
import { buildActivePath, type TurnRow } from './tree'

// ── Types ────────────────────────────────────────────────────────────────────

export type UserCategory = 'identity' | 'preference' | 'style' | 'other'
export type ProjectCategory = 'decision' | 'convention' | 'fact' | 'constraint' | 'glossary' | 'other'

export interface MemItem {
  memId: string | null
  category: string
  text: string
}

export interface EnrichUserResult {
  memories: MemItem[]
  title?: string
}

export interface EnrichProjectResult {
  memories: MemItem[]
  summary?: string
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const USER_SYSTEM_PROMPT = `You manage a persistent memory list about the user (the person typing the messages).

You receive the current memory list as JSON and a conversation transcript.
Return ONLY a valid JSON object — no markdown, no explanation:
{ "memories": [{"memId": "<existing-id or null for new>", "category": "identity|preference|style|other", "text": "<one sentence>"}, ...] }
Include "title" only when instructed.

Memory list rules (max 20 items, one sentence each):
- Retain existing items (keep their memId) that remain accurate
- Update text/category of an existing item (keep memId) when you have better information
- Omit items contradicted by new info or no longer relevant
- Add new items (memId: null) for genuinely new durable facts
- Merge near-duplicates into one item

ONLY capture: the user's own name, location, profession, stated personal preferences, communication/work style.

NEVER capture:
- Health, medical, financial, legal, or sensitive data about ANY person
- Information about third parties (patients, clients, subjects being analyzed)
- Content from documents the user is processing
- Task content or temporary context
- Anything not directly stated by the user about themselves

On parse failure or nothing notable: return the existing list unchanged (preserving existing memIds).`

const TITLE_INSTRUCTION = `Also include "title": a very short chat title (max 6 words) capturing the main topic. No quotes, no punctuation at the end.`

const PROJECT_SYSTEM_PROMPT = `You manage a persistent memory list about a project.

You receive the current memory list as JSON and a conversation transcript.
Return ONLY a valid JSON object — no markdown, no explanation:
{ "memories": [{"memId": "<existing-id or null for new>", "category": "decision|convention|fact|constraint|glossary|other", "text": "<one sentence>"}, ...], "summary": "<1-3 sentence chat summary>" }

Memory list rules (max 20 items, one sentence each):
- Retain existing items (keep memId) that remain accurate
- Update text/category of an existing item (keep memId) when you have better information
- Omit items no longer relevant or superseded
- Add new items (memId: null) for genuinely new durable project facts
- Merge near-duplicates into one item

Capture: architectural/product decisions, naming conventions, domain facts, constraints, term definitions, customer info, key facts extracted from processed documents.
Ignore: temporary task context, conversational pleasantries.`

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseMemItems(raw: unknown): MemItem[] {
  if (!Array.isArray(raw)) return []
  const result: MemItem[] = []
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    if (typeof o.category !== 'string') continue
    if (typeof o.text !== 'string' || !o.text.trim()) continue
    result.push({
      memId: (typeof o.memId === 'string' && o.memId) ? o.memId : null,
      category: o.category,
      text: o.text.trim(),
    })
  }
  return result
}

function safeParse(response: string | null | undefined): Record<string, unknown> | null {
  try {
    const cleaned = (response ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    const parsed = JSON.parse(cleaned)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

// ── enrichUserFacts ───────────────────────────────────────────────────────────

/**
 * Haiku call returning the updated user memory list (add/update/delete) and
 * optionally a title. Never throws — returns existing list unchanged on failure.
 */
export async function enrichUserFacts(
  transcript: string,
  existing: Array<{ memId: string; category: string; text: string }>,
  needTitle: boolean,
): Promise<EnrichUserResult> {
  const fallback: EnrichUserResult = {
    memories: existing.map(e => ({ memId: e.memId, category: e.category, text: e.text })),
  }
  try {
    const systemPrompt = needTitle ? `${USER_SYSTEM_PROMPT}\n\n${TITLE_INSTRUCTION}` : USER_SYSTEM_PROMPT
    const userMsg = [
      `CURRENT_MEMORIES: ${JSON.stringify(existing)}`,
      ``,
      `CONVERSATION:`,
      transcript,
    ].join('\n')

    const response = await converseOnce(
      MEMORY_EXTRACTION_MODEL,
      systemPrompt,
      [{ role: 'user', content: [{ text: userMsg }] }],
      { maxTokens: 1024 },
    )

    const obj = safeParse(response)
    if (!obj) return fallback

    const validUserCategories = new Set(['identity', 'preference', 'style', 'other'])
    const memories = parseMemItems(obj.memories).filter(m => validUserCategories.has(m.category))
    const result: EnrichUserResult = { memories: memories.length > 0 ? memories : fallback.memories }

    if (needTitle && typeof obj.title === 'string' && obj.title.trim()) {
      result.title = obj.title.trim()
    }

    return result
  } catch {
    return fallback
  }
}

// ── enrichProjectFacts ────────────────────────────────────────────────────────

/**
 * Haiku call returning the updated project memory list and a summary.
 * Never throws — returns existing list unchanged on failure.
 */
export async function enrichProjectFacts(
  transcript: string,
  existing: Array<{ memId: string; category: string; text: string }>,
): Promise<EnrichProjectResult> {
  const fallback: EnrichProjectResult = {
    memories: existing.map(e => ({ memId: e.memId, category: e.category, text: e.text })),
  }
  try {
    const userMsg = [
      `CURRENT_MEMORIES: ${JSON.stringify(existing)}`,
      ``,
      `CONVERSATION:`,
      transcript,
    ].join('\n')

    const response = await converseOnce(
      MEMORY_EXTRACTION_MODEL,
      PROJECT_SYSTEM_PROMPT,
      [{ role: 'user', content: [{ text: userMsg }] }],
      { maxTokens: 1024 },
    )

    const obj = safeParse(response)
    if (!obj) return fallback

    const validProjectCategories = new Set(['decision', 'convention', 'fact', 'constraint', 'glossary', 'other'])
    const memories = parseMemItems(obj.memories).filter(m => validProjectCategories.has(m.category))
    const result: EnrichProjectResult = { memories: memories.length > 0 ? memories : fallback.memories }

    if (typeof obj.summary === 'string' && obj.summary.trim()) {
      result.summary = obj.summary.trim()
    }

    return result
  } catch {
    return fallback
  }
}

// ── enrichChatForProject ──────────────────────────────────────────────────────

/**
 * Summary-only wrapper: loads a chat's messages, builds a transcript,
 * calls enrichProjectFacts with no existing memories to get a summary.
 * Never throws.
 */
export async function enrichChatForProject(sub: string, chatId: string): Promise<string | undefined> {
  try {
    const rows = (await listMessages(chatId)) as unknown as TurnRow[]
    if (rows.length === 0) return undefined

    const leaf = rows[rows.length - 1]
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

    const result = await enrichProjectFacts(transcript, [])
    if (result.summary) {
      await updateChatSummary(sub, chatId, result.summary)
    }
    return result.summary
  } catch {
    return undefined
  }
}
