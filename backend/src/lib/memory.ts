import { converseOnce } from './bedrock'
import { MEMORY_EXTRACTION_MODEL } from '../config/models'
import type { ToolResultBlock } from '@aws-sdk/client-bedrock-runtime'
import {
  listUserMemories, putUserMemory, deleteUserMemory, buildUserMemKey,
  listProjectMemories, putProjectMemory, deleteProjectMemory, buildProjectMemKey,
} from './dynamo'
import { v4 as uuidv4 } from 'uuid'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserMemory {
  memId: string
  text: string
  category: 'identity' | 'preference' | 'style' | 'other'
  createdAt: string
  updatedAt: string
}

export type ProjectCategory = 'decision' | 'convention' | 'fact' | 'constraint' | 'glossary' | 'other'

export interface ProjectMemory {
  memId: string
  text: string
  category: ProjectCategory
  createdAt: string
  updatedAt: string
}

export type ReconcileOp =
  | { op: 'ADD'; text: string; category: UserMemory['category'] }
  | { op: 'UPDATE'; existingId: string; text: string; category: UserMemory['category'] }
  | { op: 'DELETE'; existingId: string }
  | { op: 'NOOP'; existingId: string }

// ── Extraction ────────────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You extract durable personal facts about the user from conversation transcripts.

Output ONLY a JSON array of objects. Each object must have:
- "category": one of "identity", "preference", "style", "other"
- "text": the fact as a concise statement

Rules:
- Extract ONLY lasting personal facts about the user (e.g. name, location, language, profession, stated preferences, communication style preferences).
- IGNORE: task-specific content, questions the user asked, temporary context, system instructions, bot responses, anything that is not a durable personal fact about the user.
- If there are no durable facts, return an empty array: []
- Return ONLY the JSON array, no explanation, no markdown.`

/**
 * Call Bedrock with the extraction prompt and return structured facts.
 * Never throws — returns [] on any error.
 */
export async function extractUserFacts(
  transcript: string,
): Promise<Array<{ category: UserMemory['category']; text: string }>> {
  try {
    const response = await converseOnce(
      MEMORY_EXTRACTION_MODEL,
      EXTRACTION_SYSTEM_PROMPT,
      [{ role: 'user', content: [{ text: transcript }] }],
      { maxTokens: 512 },
    )

    let parsed: unknown
    try {
      parsed = JSON.parse(response)
    } catch {
      return []
    }

    if (!Array.isArray(parsed)) return []

    return (parsed as unknown[]).filter(
      (item): item is { category: UserMemory['category']; text: string } => {
        if (typeof item !== 'object' || item === null) return false
        const o = item as Record<string, unknown>
        return (
          typeof o.category === 'string' &&
          ['identity', 'preference', 'style', 'other'].includes(o.category) &&
          typeof o.text === 'string' &&
          o.text.length > 0
        )
      },
    )
  } catch {
    return []
  }
}

// ── Reconcile ─────────────────────────────────────────────────────────────────

/**
 * Phase 1: ADD-only reconciliation with exact-text deduplication.
 *
 * For each candidate:
 *   - If an existing memory's normalized text matches → NOOP (with existingId)
 *   - Otherwise → ADD
 *
 * Existing memories that had no matching candidate are also emitted as NOOP
 * (they are unchanged).
 *
 * DELETE and UPDATE are intentionally absent (Phase 2).
 */
export function reconcile(
  candidates: Array<{ category: UserMemory['category']; text: string }>,
  existing: UserMemory[],
): ReconcileOp[] {
  const ops: ReconcileOp[] = []

  // Track which existing memory IDs were matched so we can NOOP the rest
  const matchedExistingIds = new Set<string>()

  for (const candidate of candidates) {
    const normalizedCandidate = candidate.text.trim().toLowerCase()

    const match = existing.find(
      e => e.text.trim().toLowerCase() === normalizedCandidate,
    )

    if (match) {
      matchedExistingIds.add(match.memId)
      ops.push({ op: 'NOOP', existingId: match.memId })
    } else {
      ops.push({ op: 'ADD', text: candidate.text, category: candidate.category })
    }
  }

  // Any existing memory not matched by a candidate is unchanged → NOOP
  for (const e of existing) {
    if (!matchedExistingIds.has(e.memId)) {
      ops.push({ op: 'NOOP', existingId: e.memId })
    }
  }

  return ops
}

// ── Memory tool executor ──────────────────────────────────────────────────────

const VALID_CATEGORIES = new Set<string>(['identity', 'preference', 'style', 'other'])

function errorResult(message: string): ToolResultBlock {
  return { toolUseId: '', content: [{ text: message }], status: 'error' }
}

function successResult(message: string): ToolResultBlock {
  return { toolUseId: '', content: [{ text: message }], status: 'success' }
}

/**
 * Execute the manage_memory tool operation.
 * ctx: { sub: string } — user identity from authenticated context, NOT from model input.
 * Never throws — always returns a ToolResultBlock.
 */
export async function executeMemoryTool(
  input: Record<string, string>,
  ctx: { sub: string },
): Promise<ToolResultBlock> {
  try {
    const { operation } = input

    if (operation === 'remember') {
      if (!input.text || !input.text.trim()) {
        return errorResult('text is required for remember operation.')
      }
      if (!VALID_CATEGORIES.has(input.category)) {
        return errorResult(`category must be one of: identity, preference, style, other.`)
      }

      const existingRaw = await listUserMemories(ctx.sub)
      const existing: UserMemory[] = existingRaw.map(i => ({
        memId: i.memId as string,
        text: i.text as string,
        category: i.category as UserMemory['category'],
        createdAt: i.createdAt as string,
        updatedAt: i.updatedAt as string,
      }))

      const ops = reconcile([{ category: input.category as UserMemory['category'], text: input.text }], existing)
      const addOp = ops.find(o => o.op === 'ADD')

      if (!addOp) {
        console.log(JSON.stringify({ event: 'memory_tool', op: 'remember', result: 'already_known' }))
        return successResult('Already known.')
      }

      const memId = uuidv4()
      const now = new Date().toISOString()
      await putUserMemory({
        ...buildUserMemKey(ctx.sub, memId),
        memId,
        text: input.text,
        category: input.category,
        createdAt: now,
        updatedAt: now,
      })
      console.log(JSON.stringify({ event: 'memory_tool', op: 'remember', result: 'saved' }))
      return successResult('Saved.')
    }

    if (operation === 'update') {
      if (!input.memId) {
        return errorResult('memId is required for update operation.')
      }
      if (!input.text || !input.text.trim()) {
        return errorResult('text is required for update operation.')
      }

      const existingRaw = await listUserMemories(ctx.sub)
      const existing = existingRaw.find(i => (i.memId as string) === input.memId)

      if (!existing) {
        return errorResult(`Memory not found. Use 'remember' to save a new fact.`)
      }

      const now = new Date().toISOString()
      const newCategory = (input.category && VALID_CATEGORIES.has(input.category))
        ? input.category
        : (existing.category as string)

      await putUserMemory({
        ...buildUserMemKey(ctx.sub, input.memId),
        memId: input.memId,
        text: input.text,
        category: newCategory,
        createdAt: existing.createdAt as string,
        updatedAt: now,
      })
      console.log(JSON.stringify({ event: 'memory_tool', op: 'update', result: 'updated' }))
      return successResult('Updated.')
    }

    if (operation === 'forget') {
      if (!input.memId) {
        return errorResult('memId is required for forget operation.')
      }

      const existingRaw = await listUserMemories(ctx.sub)
      const existing = existingRaw.find(i => (i.memId as string) === input.memId)

      if (!existing) {
        return errorResult(`Memory not found.`)
      }

      await deleteUserMemory(ctx.sub, input.memId)
      console.log(JSON.stringify({ event: 'memory_tool', op: 'forget', result: 'forgotten' }))
      return successResult('Forgotten.')
    }

    return errorResult(`Unknown operation: ${operation}. Must be one of: remember, update, forget.`)
  } catch (err) {
    return errorResult(`Memory tool error: ${String(err)}`)
  }
}

// ── Project memory tool executor ──────────────────────────────────────────────

const VALID_PROJECT_CATEGORIES = new Set<string>(['decision', 'convention', 'fact', 'constraint', 'glossary', 'other'])

/**
 * Execute the manage_project_memory tool operation.
 * ctx: { projectId: string } — project identity from authenticated context, NOT from model input.
 * Never throws — always returns a ToolResultBlock.
 */
export async function executeProjectMemoryTool(
  input: Record<string, string>,
  ctx: { projectId: string },
): Promise<ToolResultBlock> {
  try {
    const { operation } = input

    if (operation === 'remember') {
      if (!input.text || !input.text.trim()) {
        return errorResult('text is required for remember operation.')
      }
      if (!VALID_PROJECT_CATEGORIES.has(input.category)) {
        return errorResult(`category must be one of: decision, convention, fact, constraint, glossary, other.`)
      }

      const existingRaw = await listProjectMemories(ctx.projectId)
      const normalizedNew = input.text.trim().toLowerCase()
      const isDuplicate = existingRaw.some(i => (i.text as string).trim().toLowerCase() === normalizedNew)

      if (isDuplicate) {
        console.log(JSON.stringify({ event: 'project_memory_tool', op: 'remember', result: 'already_known' }))
        return successResult('Already known.')
      }

      const memId = uuidv4()
      const now = new Date().toISOString()
      await putProjectMemory({
        ...buildProjectMemKey(ctx.projectId, memId),
        memId,
        text: input.text,
        category: input.category,
        createdAt: now,
        updatedAt: now,
      })
      console.log(JSON.stringify({ event: 'project_memory_tool', op: 'remember', result: 'saved' }))
      return successResult('Saved.')
    }

    if (operation === 'update') {
      if (!input.memId) {
        return errorResult('memId is required for update operation.')
      }
      if (!input.text || !input.text.trim()) {
        return errorResult('text is required for update operation.')
      }

      const existingRaw = await listProjectMemories(ctx.projectId)
      const existing = existingRaw.find(i => (i.memId as string) === input.memId)

      if (!existing) {
        return errorResult(`Memory not found. Use 'remember' to save a new fact.`)
      }

      const now = new Date().toISOString()
      const newCategory = (input.category && VALID_PROJECT_CATEGORIES.has(input.category))
        ? input.category
        : (existing.category as string)

      await putProjectMemory({
        ...buildProjectMemKey(ctx.projectId, input.memId),
        memId: input.memId,
        text: input.text,
        category: newCategory,
        createdAt: existing.createdAt as string,
        updatedAt: now,
      })
      console.log(JSON.stringify({ event: 'project_memory_tool', op: 'update', result: 'updated' }))
      return successResult('Updated.')
    }

    if (operation === 'forget') {
      if (!input.memId) {
        return errorResult('memId is required for forget operation.')
      }

      const existingRaw = await listProjectMemories(ctx.projectId)
      const existing = existingRaw.find(i => (i.memId as string) === input.memId)

      if (!existing) {
        return errorResult(`Memory not found.`)
      }

      await deleteProjectMemory(ctx.projectId, input.memId)
      console.log(JSON.stringify({ event: 'project_memory_tool', op: 'forget', result: 'forgotten' }))
      return successResult('Forgotten.')
    }

    return errorResult(`Unknown operation: ${operation}. Must be one of: remember, update, forget.`)
  } catch (err) {
    return errorResult(`Project memory tool error: ${String(err)}`)
  }
}
