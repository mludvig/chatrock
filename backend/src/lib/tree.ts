import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime'
import type { TokenUsage } from './bedrock'

// Minimal shape needed for tree operations (superset of TurnRow)
export interface TurnRow {
  PK: string
  SK: string
  msgId: string
  parentId: string | null
  role: 'user' | 'assistant'
  blocks: ContentBlock[]
  model: string
  createdAt: string
  turnIndex: number
  responseId: string
  usage?: TokenUsage
}

/**
 * Build the active-path through the conversation tree, returned in root→leaf order.
 *
 * Algorithm:
 *   1. If rows is empty, return [].
 *   2. Resolve the starting leaf: activeLeafId if it maps to a known row,
 *      otherwise fall back to the last row in the array.
 *   3. Walk up via parentId, collecting rows into a path (bounded by row count
 *      to guard against cycles).
 *   4. Reverse to root→leaf order.
 *
 * For a single-branch conversation (no siblings), this produces the same
 * ordering as the flat listMessages array — byte-stable prefix for caching.
 */
export function buildActivePath(rows: TurnRow[], activeLeafId: string | null): TurnRow[] {
  if (rows.length === 0) return []

  const byId = new Map<string, TurnRow>()
  for (const row of rows) {
    byId.set(row.msgId, row)
  }

  // Resolve starting leaf
  let leaf: TurnRow | undefined = activeLeafId != null ? byId.get(activeLeafId) : undefined
  if (!leaf) {
    leaf = rows[rows.length - 1]
  }

  // Walk up via parentId; bound by row count to prevent cycles
  const path: TurnRow[] = []
  const visited = new Set<string>()
  let current: TurnRow | undefined = leaf
  const maxSteps = rows.length

  for (let i = 0; i < maxSteps && current !== undefined; i++) {
    if (visited.has(current.msgId)) break  // cycle detected
    visited.add(current.msgId)
    path.push(current)
    current = current.parentId != null ? byId.get(current.parentId) : undefined
  }

  path.reverse()
  return path
}

/**
 * Walk *down* within a single response group (same responseId) from a given
 * node to the last turn of that group.
 *
 * Used by the fork handler to resolve an assistant bubble's msgId (the *first*
 * turn of its response) to the deepest turn sharing that responseId, so a fork
 * never ends with a dangling tool_use block.
 *
 * If msgId is not found in rows, returns msgId unchanged.
 */
export function resolveResponseLeaf(rows: TurnRow[], msgId: string): string {
  if (rows.length === 0) return msgId

  const startRow = rows.find(r => r.msgId === msgId)
  if (!startRow) return msgId

  const targetResponseId = startRow.responseId

  // Build parentId → children[] map, preserving row order, filtered to same responseId
  const children = new Map<string, string[]>()
  for (const row of rows) {
    if (row.parentId != null && row.responseId === targetResponseId) {
      const list = children.get(row.parentId) ?? []
      list.push(row.msgId)
      children.set(row.parentId, list)
    }
  }

  // Walk down within the response group: pick the last child at each step
  let current = msgId
  const visited = new Set<string>()
  for (let i = 0; i < rows.length; i++) {
    if (visited.has(current)) break
    visited.add(current)
    const kids = children.get(current)
    if (!kids || kids.length === 0) break
    current = kids[kids.length - 1]
  }
  return current
}

/**
 * Walk *down* from a node to the leaf of its branch.
 *
 * At each fork, picks the **last child in row order** (most recently created).
 * Bounded by row count to guard against cycles.
 *
 * If msgId is not found in rows, returns msgId unchanged (caller validates).
 */
export function resolveLeaf(rows: TurnRow[], msgId: string): string {
  if (rows.length === 0) return msgId

  // Build parentId → children[] map, preserving row order
  const children = new Map<string, string[]>()
  for (const row of rows) {
    if (row.parentId != null) {
      const list = children.get(row.parentId) ?? []
      list.push(row.msgId)
      children.set(row.parentId, list)
    }
  }

  // Walk down: at each step pick the last child; stop when no children
  let current = msgId
  const visited = new Set<string>()
  for (let i = 0; i < rows.length; i++) {
    if (visited.has(current)) break
    visited.add(current)
    const kids = children.get(current)
    if (!kids || kids.length === 0) break
    current = kids[kids.length - 1]
  }
  return current
}
