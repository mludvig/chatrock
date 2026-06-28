import { converseOnce } from './bedrock'
import { MEMORY_EXTRACTION_MODEL, TITLE_MODEL } from '../config/models'
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
}

export interface EnrichProjectResult {
  memories: MemItem[]
}

export interface ChatSummaryResult {
  summary: string
  topics: string[]
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
- Some facts may already have been saved this turn (they appear in the list above with a memId, possibly worded differently). Keep and merge with the existing item — reuse its memId; do NOT add a second item (memId: null) restating a fact already present in any form.

ONLY capture: the user's own name, location, profession, stated personal preferences, communication/work style.

NEVER capture:
- Health, medical, financial, legal, or sensitive data about ANY person
- Information about third parties (patients, clients, subjects being analyzed)
- Content from documents the user is processing
- Task content or temporary context
- Anything not directly stated by the user about themselves

On parse failure or nothing notable: return the existing list unchanged (preserving existing memIds).`

const TITLE_PROMPT = `Generate a very short chat title (max 6 words) that captures the main topic of the conversation below. Reply with ONLY the title, no quotes, no punctuation at the end.`

const SUMMARIZE_CHAT_SYSTEM_PROMPT = `You maintain a running summary and topic list for a chat conversation, updated incrementally after each turn.

You receive the EXISTING summary/topics (empty if this is the first turn) and the LATEST exchange — not the full history.
Return ONLY a valid JSON object — no markdown, no explanation:
{ "summary": "<1-3 sentence summary of the conversation as a whole>", "topics": ["<short topic phrase>", ...] }

Rules:
- Merge the latest exchange into the existing summary/topics — don't discard prior context, but drop topics that are no longer relevant.
- summary: 1-3 sentences describing what the conversation has covered overall, not just the latest exchange.
- topics: 2-8 short noun phrases (2-5 words each), specific enough to be useful for search later (e.g. "S3 Athena query tuning", not "AWS").
- If nothing substantive has been discussed yet (e.g. just a greeting), return { "summary": "", "topics": [] }.`

const PROJECT_SYSTEM_PROMPT = `You manage a persistent memory list about a project. The list accumulates durable facts that are SPECIFIC TO THIS PROJECT and were established or confirmed BY THE USER — the context a new teammate would need to continue this project.

You receive the current memory list as JSON and a conversation transcript with "User:" and "Assistant:" turns.
Return ONLY a valid JSON object — no markdown, no explanation:
{ "memories": [{"memId": "<existing-id or null for new>", "category": "decision|convention|fact|constraint|glossary|other", "text": "<one sentence>"}, ...] }

PROVENANCE IS DECISIVE. A memory must come from the USER — something they decided, chose, required, named, or told you about their own project, environment, customer, or data. Do NOT record knowledge the ASSISTANT produced while explaining, teaching, comparing, or summarising a topic, even when it is accurate. When the user asks "what is X" or "explain Y", the assistant's reply is general reference material, NOT a project fact.

LITMUS TEST before adding any item: "Could someone find this in public documentation without knowing this user's project?" If yes, it is general knowledge — DO NOT capture it. Only capture facts that are true *because of this specific project*.

Capture (only when stated or chosen by the user):
- decision: choices the user made for this project
- convention: naming/structure the user adopted
- constraint: requirements or limits the user imposed
- fact: details of the user's own environment, customer, accounts, or data
- glossary: project-specific terms the user introduces (NOT definitions of public products)

Never capture:
- definitions or descriptions of public products, tools, services, or concepts
- how a technology works in general
- tutorials, step-by-step explanations, or comparisons the assistant generated
- temporary task context or conversational pleasantries

Memory list rules (max 20 items, one sentence each):
- Retain existing items (keep memId) that remain accurate and project-specific
- Update text/category of an existing item (keep memId) when you have better information
- Omit items that are not project-specific, are superseded, or are general knowledge
- Add new items (memId: null) only for genuinely new, user-established project facts
- Merge near-duplicates into one item
- Some project facts may already have been saved this turn (they appear in the list above with a memId, possibly worded differently). Keep and merge with the existing item — reuse its memId; do NOT add a second item (memId: null) restating a fact already present in any form.

When the turn contains nothing project-specific from the user: return the existing list unchanged (preserving existing memIds).`

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

// Exported for reuse by other defensive-JSON-parsing callers (e.g. lib/search.ts) — single
// implementation of "strip code fences, parse, require a plain object" rather than duplicating it.
export function safeParse(response: string | null | undefined): Record<string, unknown> | null {
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
 * Haiku call returning the updated user memory list (add/update/delete).
 * Never throws — returns existing list unchanged on failure, logging why.
 */
export async function enrichUserFacts(
  transcript: string,
  existing: Array<{ memId: string; category: string; text: string }>,
  chatId?: string,
): Promise<EnrichUserResult> {
  const fallback: EnrichUserResult = {
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
      USER_SYSTEM_PROMPT,
      [{ role: 'user', content: [{ text: userMsg }] }],
      { maxTokens: 1024 },
    )

    const obj = safeParse(response)
    if (!obj) {
      console.error(JSON.stringify({ event: 'enrich_user_facts_parse_error', chatId, response: response?.slice(0, 500) }))
      return fallback
    }

    const validUserCategories = new Set(['identity', 'preference', 'style', 'other'])
    const memories = parseMemItems(obj.memories).filter(m => validUserCategories.has(m.category))
    return { memories: memories.length > 0 ? memories : fallback.memories }
  } catch (err) {
    console.error(JSON.stringify({ event: 'enrich_user_facts_error', chatId, error: String(err) }))
    return fallback
  }
}

/**
 * Haiku call generating a short chat title from a conversation transcript.
 * Independent of enrichUserFacts so a memory-extraction failure can never
 * take the title down with it. Never throws — returns undefined on failure.
 */
export async function generateChatTitle(transcript: string, chatId?: string): Promise<string | undefined> {
  try {
    const response = await converseOnce(
      TITLE_MODEL,
      '',
      [{ role: 'user', content: [{ text: `${TITLE_PROMPT}\n\n${transcript}` }] }],
      { maxTokens: 32 },
    )
    const title = response.trim()
    if (!title) {
      console.error(JSON.stringify({ event: 'generate_title_empty_response', chatId }))
      return undefined
    }
    return title
  } catch (err) {
    console.error(JSON.stringify({ event: 'generate_title_error', chatId, error: String(err) }))
    return undefined
  }
}

// ── enrichProjectFacts ────────────────────────────────────────────────────────

/**
 * Haiku call returning the updated project memory list.
 * Never throws — returns existing list unchanged on failure.
 */
export async function enrichProjectFacts(
  transcript: string,
  existing: Array<{ memId: string; category: string; text: string }>,
  chatId?: string,
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
    if (!obj) {
      console.error(JSON.stringify({ event: 'enrich_project_facts_parse_error', chatId, response: response?.slice(0, 500) }))
      return fallback
    }

    const validProjectCategories = new Set(['decision', 'convention', 'fact', 'constraint', 'glossary', 'other'])
    const memories = parseMemItems(obj.memories).filter(m => validProjectCategories.has(m.category))
    return { memories: memories.length > 0 ? memories : fallback.memories }
  } catch (err) {
    console.error(JSON.stringify({ event: 'enrich_project_facts_error', chatId, error: String(err) }))
    return fallback
  }
}

// ── summarizeChat ────────────────────────────────────────────────────────────

/**
 * Haiku call that merges the latest exchange into a running summary + topic
 * list for a chat. Independent of project membership — every chat gets one.
 * Never throws — returns { summary: '', topics: [] } on failure.
 */
export async function summarizeChat(
  transcript: string,
  existingSummary: string,
  existingTopics: string[],
  chatId?: string,
): Promise<ChatSummaryResult> {
  const fallback: ChatSummaryResult = { summary: '', topics: [] }
  try {
    const userMsg = [
      `EXISTING_SUMMARY: ${existingSummary || '(none yet)'}`,
      `EXISTING_TOPICS: ${JSON.stringify(existingTopics)}`,
      ``,
      `LATEST_EXCHANGE:`,
      transcript,
    ].join('\n')

    const response = await converseOnce(
      MEMORY_EXTRACTION_MODEL,
      SUMMARIZE_CHAT_SYSTEM_PROMPT,
      [{ role: 'user', content: [{ text: userMsg }] }],
      { maxTokens: 512 },
    )

    const obj = safeParse(response)
    if (!obj) {
      console.error(JSON.stringify({ event: 'summarize_chat_parse_error', chatId, response: response?.slice(0, 500) }))
      return fallback
    }

    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
    const topics = Array.isArray(obj.topics)
      ? obj.topics.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map(t => t.trim()).slice(0, 8)
      : []
    return { summary, topics }
  } catch (err) {
    console.error(JSON.stringify({ event: 'summarize_chat_error', chatId, error: String(err) }))
    return fallback
  }
}

/**
 * Loads a chat's messages, builds a transcript from the last 20 turns, and
 * calls summarizeChat with no existing summary/topics (a fresh rebuild,
 * not an incremental merge) — used to backfill a chat immediately (e.g. on
 * moving it into a project) rather than waiting for its next turn.
 * Never throws.
 */
export async function summarizeChatById(sub: string, chatId: string): Promise<ChatSummaryResult | undefined> {
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

    const result = await summarizeChat(transcript, '', [], chatId)
    if (result.summary || result.topics.length > 0) {
      await updateChatSummary(sub, chatId, { summary: result.summary, topics: result.topics })
    }
    return result
  } catch {
    return undefined
  }
}
