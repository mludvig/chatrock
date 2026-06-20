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

  // Resolve starting leaf. If activeLeafId is missing/stale, fall back to a tree-derived
  // choice (most-recently-created reachable leaf) rather than raw array order — array order
  // isn't guaranteed to correspond to any sensible branch tip.
  let leaf: TurnRow | undefined = activeLeafId != null ? byId.get(activeLeafId) : undefined
  if (!leaf) {
    const fallbackId = mostRecentLeaf(rows)
    leaf = fallbackId != null ? byId.get(fallbackId) : undefined
  }
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
 * Collect all msgIds in the subtree rooted at msgId (BFS over parentId children).
 * Always includes msgId itself, even if not found in rows (allows callers to delete
 * by msgId even when rows are stale).
 */
export function subtreeMsgIds(rows: TurnRow[], msgId: string): string[] {
  if (rows.length === 0) return [msgId]

  // Build parentId → children[] map
  const children = new Map<string, string[]>()
  for (const row of rows) {
    if (row.parentId != null) {
      const list = children.get(row.parentId) ?? []
      list.push(row.msgId)
      children.set(row.parentId, list)
    }
  }

  // BFS from msgId
  const result: string[] = []
  const queue: string[] = [msgId]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    result.push(current)
    const kids = children.get(current)
    if (kids) queue.push(...kids)
  }
  return result
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

/**
 * Tree-derived fallback for "what's the current leaf" when there's no (valid) stored
 * pointer to start from: walk down from every root (parentId == null) via resolveLeaf's
 * "last child wins" rule, then pick whichever terminal leaf has the latest createdAt.
 *
 * Used both as buildActivePath's fallback when activeLeafId doesn't resolve, and as
 * resolveSafeLeaf's fallback when a candidate msgId isn't found in rows. Returns null only
 * when rows is empty or contains no reachable root (a malformed/headless tree).
 */
export function mostRecentLeaf(rows: TurnRow[]): string | null {
  if (rows.length === 0) return null

  const byId = new Map<string, TurnRow>()
  for (const row of rows) byId.set(row.msgId, row)

  const roots = rows.filter(r => r.parentId == null)
  let best: TurnRow | undefined
  for (const root of roots) {
    const leafId = resolveLeaf(rows, root.msgId)
    const leafRow = byId.get(leafId)
    if (leafRow && (!best || leafRow.createdAt > best.createdAt)) best = leafRow
  }
  return best?.msgId ?? null
}

/**
 * Validated chokepoint for resolving a new activeLeafId: confirms candidateMsgId actually
 * exists in rows before resolving it down to its branch's leaf. If candidateMsgId is null or
 * doesn't exist (e.g. it referenced a turn that was never durably persisted, or was deleted
 * separately), falls back to mostRecentLeaf instead of silently persisting a phantom pointer.
 *
 * Always returns either a msgId guaranteed to exist in rows, or null (empty/headless tree).
 * Callers that want to reject an invalid client-supplied id outright (rather than silently
 * substituting a fallback) should validate existence themselves before calling this.
 */
export function resolveSafeLeaf(rows: TurnRow[], candidateMsgId: string | null): string | null {
  if (rows.length === 0) return null
  if (candidateMsgId != null && rows.some(r => r.msgId === candidateMsgId)) {
    return resolveLeaf(rows, candidateMsgId)
  }
  return mostRecentLeaf(rows)
}
