import { converseOnce } from './bedrock'
import { MEMORY_EXTRACTION_MODEL } from '../config/models'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserMemory {
  memId: string
  text: string
  category: 'identity' | 'preference' | 'style' | 'other'
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
