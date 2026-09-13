import { converseOnce } from './bedrock'
import { MEMORY_EXTRACTION_MODEL, TITLE_MODEL } from '../config/models'
import { getChat, getProject, listMessages, updateChatSummary, listProjectMemories, putProjectMemory, deleteProjectMemory, buildProjectMemKey } from './dynamo'
import { buildActivePath, type TurnRow } from './tree'
import { reconcileMemoryList } from './memory'
import { newId } from './ids'
import USER_SYSTEM_PROMPT from '../../prompts/user-memory-extraction.txt'
import TITLE_PROMPT from '../../prompts/chat-title.txt'
import SUMMARIZE_CHAT_SYSTEM_PROMPT from '../../prompts/chat-summary.txt'
import PROJECT_SYSTEM_PROMPT from '../../prompts/project-memory-extraction.txt'

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
  const cleaned = (response ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  const tryParse = (text: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(text)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
    } catch {
      return null
    }
  }
  const direct = tryParse(cleaned)
  if (direct) return direct
  // Some models prepend a sentence of reasoning before the JSON object instead of
  // emitting JSON-only output as instructed — fall back to the outermost {...} span
  // rather than treating the whole prose+JSON string as unparseable.
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  return start >= 0 && end > start ? tryParse(cleaned.slice(start, end + 1)) : null
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
      [{ role: 'user', content: [{ kind: 'text', text: userMsg }] }],
      { maxTokens: 1024, call: { purpose: 'enrich_user_facts', chatId } },
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
      [{ role: 'user', content: [{ kind: 'text', text: `${TITLE_PROMPT}\n\n${transcript}` }] }],
      { maxTokens: 32, call: { purpose: 'chat_title', chatId } },
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
      [{ role: 'user', content: [{ kind: 'text', text: userMsg }] }],
      { maxTokens: 1024, call: { purpose: 'enrich_project_facts', chatId } },
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
      [{ role: 'user', content: [{ kind: 'text', text: userMsg }] }],
      { maxTokens: 512, call: { purpose: 'chat_summary', chatId } },
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
    const transcript = await buildChatTranscript(sub, chatId)
    if (!transcript) return undefined

    const result = await summarizeChat(transcript, '', [], chatId)
    if (result.summary || result.topics.length > 0) {
      await updateChatSummary(sub, chatId, { summary: result.summary, topics: result.topics })
    }
    return result
  } catch {
    return undefined
  }
}

/**
 * Loads a chat's messages and builds a transcript from the last 20 turns —
 * shared by summarizeChatById and enrichProjectFactsByChatId, both of which
 * backfill a chat's contribution to a store immediately (e.g. on moving it
 * into a project) rather than waiting for its next turn.
 */
async function buildChatTranscript(sub: string, chatId: string): Promise<string | undefined> {
  const chat = await getChat(sub, chatId)
  if (!chat || chat.sensitive === true) return undefined
  const rows = (await listMessages(chatId)) as unknown as TurnRow[]
  if (rows.length === 0) return undefined

  const path = buildActivePath(rows, (chat.activeLeafId as string | undefined) ?? null)
  if (path.length === 0) return undefined

  return path
    .filter(r => r.role === 'user' || r.role === 'assistant')
    .slice(-20)
    .map(r => {
      const text = r.blocks.filter(b => b.kind === 'text').map(b => b.text).filter(Boolean).join(' ').slice(0, 400)
      return `${r.role === 'user' ? 'User' : 'Assistant'}: ${text}`
    })
    .join('\n')
}

/**
 * Backfills project memory for a chat moved into a project: reads the
 * project's current memory, extracts facts from this chat's transcript, and
 * reconciles/applies the resulting ops — the project-memory analogue of
 * summarizeChatById. Without this, a chat moved into a project only
 * contributes to project memory on its *next* turn, never for the history
 * it already carries in. Never throws.
 */
export async function enrichProjectFactsByChatId(chatId: string, projectId: string, sub: string): Promise<void> {
  try {
    const project = await getProject(sub, projectId)
    const chat = await getChat(sub, chatId)
    if (!project || project.memoryEnabled === false || !chat || chat.projectId !== projectId || chat.sensitive === true) return
    const transcript = await buildChatTranscript(sub, chatId)
    if (!transcript) return

    const existingRaw = await listProjectMemories(projectId)
    const existing = (existingRaw as Record<string, unknown>[]).map(i => ({
      memId: i.memId as string,
      text: i.text as string,
      category: i.category as string,
      createdAt: i.createdAt as string,
          userEdited: i.userEdited === true,
    }))

    const result = await enrichProjectFacts(transcript, existing, chatId)
    const ops = reconcileMemoryList(result.memories, existing)
    const now = new Date().toISOString()
    for (const op of ops) {
      if (op.op === 'ADD') {
        const memId = newId()
        await putProjectMemory({ ...buildProjectMemKey(projectId, memId), memId, sourceChatId: chatId, text: op.text, category: op.category, createdAt: now, updatedAt: now })
      } else if (op.op === 'UPDATE') {
        await putProjectMemory({ ...buildProjectMemKey(projectId, op.memId), memId: op.memId, sourceChatId: chatId, text: op.text, category: op.category, createdAt: op.createdAt, updatedAt: now })
      } else if (op.op === 'DELETE') {
        await deleteProjectMemory(projectId, op.memId)
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ event: 'enrich_project_facts_by_chat_id_error', chatId, projectId, error: String(err) }))
  }
}
