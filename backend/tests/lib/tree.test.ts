/**
 * Tests for lib/tree.ts — buildActivePath
 *
 * buildActivePath(rows, activeLeafId) walks leaf→root via parentId, reverses
 * to root→leaf order, and returns only the active branch's rows.
 */
import { buildActivePath, resolveLeaf, resolveResponseLeaf, mostRecentLeaf, resolveSafeLeaf } from '../../src/lib/tree'

import type { TurnRow } from '../../src/lib/tree'

function makeRow(msgId: string, parentId: string | null, overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    PK: `CHAT#test-chat`,
    SK: `MSG#2025-01-01T00:00:00.000Z#0000#${msgId}`,
    msgId,
    parentId,
    role: 'user',
    blocks: [],
    model: 'test-model',
    createdAt: '2025-01-01T00:00:00.000Z',
    turnIndex: 0,
    responseId: 'r1',
    ...overrides,
  }
}

// ── (a) Linear rows + matching activeLeafId → full list in root→leaf order ────

test('linear chain: returns rows in root→leaf order', () => {
  const rows = [
    makeRow('msg-1', null),
    makeRow('msg-2', 'msg-1'),
    makeRow('msg-3', 'msg-2'),
  ]
  const result = buildActivePath(rows, 'msg-3')
  expect(result.map(r => r.msgId)).toEqual(['msg-1', 'msg-2', 'msg-3'])
})

// ── (b) activeLeafId null but rows present → falls back to last row's leaf ───

test('null activeLeafId: falls back to the tree-derived most-recent leaf', () => {
  const rows = [
    makeRow('msg-a', null),
    makeRow('msg-b', 'msg-a'),
  ]
  const result = buildActivePath(rows, null)
  expect(result.map(r => r.msgId)).toEqual(['msg-a', 'msg-b'])
})

test('null activeLeafId with multiple root siblings: falls back to the most-recently-created branch, not array order', () => {
  // msg-old (root, older) -> msg-old-child is LAST in array order, but msg-new (root,
  // created later) should win the fallback — array order must not matter.
  const rows = [
    makeRow('msg-new', null, { createdAt: '2025-01-02T00:00:00.000Z' }),
    makeRow('msg-old', null, { createdAt: '2025-01-01T00:00:00.000Z' }),
    makeRow('msg-old-child', 'msg-old', { createdAt: '2025-01-01T00:00:01.000Z' }),
  ]
  const result = buildActivePath(rows, null)
  expect(result.map(r => r.msgId)).toEqual(['msg-new'])
})

// ── (c) Tree with two siblings: returns only the active branch ────────────────
//
//   user-1 → assistant-A (active leaf)
//         → assistant-B (inactive sibling)

test('two assistant siblings: returns only the active branch', () => {
  const rows = [
    makeRow('user-1', null, { role: 'user' }),
    makeRow('asst-A', 'user-1', { role: 'assistant' }),
    makeRow('asst-B', 'user-1', { role: 'assistant' }),
  ]
  // Active leaf is asst-A → path should be [user-1, asst-A], not asst-B
  const result = buildActivePath(rows, 'asst-A')
  expect(result.map(r => r.msgId)).toEqual(['user-1', 'asst-A'])
})

test('two assistant siblings: switching to the other sibling returns only that branch', () => {
  const rows = [
    makeRow('user-1', null, { role: 'user' }),
    makeRow('asst-A', 'user-1', { role: 'assistant' }),
    makeRow('asst-B', 'user-1', { role: 'assistant' }),
  ]
  const result = buildActivePath(rows, 'asst-B')
  expect(result.map(r => r.msgId)).toEqual(['user-1', 'asst-B'])
})

// ── (c-deep) Deeper tree with sibling subtrees ────────────────────────────────
//
//   root → user-1 → asst-A → user-2A → asst-C   (active leaf)
//                → asst-B → user-2B → asst-D    (inactive branch)

test('deeper tree: returns only the root→activeLeaf path', () => {
  const rows = [
    makeRow('root', null),
    makeRow('user-1', 'root'),
    makeRow('asst-A', 'user-1'),
    makeRow('asst-B', 'user-1'),
    makeRow('user-2A', 'asst-A'),
    makeRow('user-2B', 'asst-B'),
    makeRow('asst-C', 'user-2A'),
    makeRow('asst-D', 'user-2B'),
  ]
  const result = buildActivePath(rows, 'asst-C')
  expect(result.map(r => r.msgId)).toEqual(['root', 'user-1', 'asst-A', 'user-2A', 'asst-C'])
})

// ── (d) Cycle/self-parent → terminates, does not infinite-loop ────────────────

test('self-referential parentId: terminates without infinite loop', () => {
  const rows = [makeRow('msg-x', 'msg-x')]
  // Should not throw or hang; may return [] or just the one row
  expect(() => buildActivePath(rows, 'msg-x')).not.toThrow()
})

test('two-node cycle: terminates without infinite loop', () => {
  const rows = [
    makeRow('msg-a', 'msg-b'),
    makeRow('msg-b', 'msg-a'),
  ]
  expect(() => buildActivePath(rows, 'msg-b')).not.toThrow()
})

// ── (e) Empty rows → [] ───────────────────────────────────────────────────────

test('empty rows: returns []', () => {
  expect(buildActivePath([], 'any-leaf')).toEqual([])
  expect(buildActivePath([], null)).toEqual([])
})

// ── (f) Unresolvable activeLeafId → returns all rows in array order ───────────

test('unresolvable activeLeafId: falls back to the tree-derived most-recent leaf', () => {
  const rows = [
    makeRow('msg-1', null),
    makeRow('msg-2', 'msg-1'),
  ]
  // 'nonexistent' is not in the rows — should fall back gracefully
  const result = buildActivePath(rows, 'nonexistent')
  expect(result.map(r => r.msgId)).toEqual(['msg-1', 'msg-2'])
})

// ── resolveLeaf ───────────────────────────────────────────────────────────────

test('inc4: resolveLeaf — linear chain returns deepest node', () => {
  const rows = [
    makeRow('a', null),
    makeRow('b', 'a'),
    makeRow('c', 'b'),
  ]
  expect(resolveLeaf(rows, 'a')).toBe('c')
  expect(resolveLeaf(rows, 'b')).toBe('c')
})

test('inc4: resolveLeaf — leaf node returns itself', () => {
  const rows = [
    makeRow('a', null),
    makeRow('b', 'a'),
  ]
  expect(resolveLeaf(rows, 'b')).toBe('b')
})

test('inc4: resolveLeaf — multiple children picks last child in row order', () => {
  // user → asst-A (first), asst-B (second, last in array)
  const rows = [
    makeRow('user', null),
    makeRow('asst-A', 'user'),
    makeRow('asst-B', 'user'),
  ]
  expect(resolveLeaf(rows, 'user')).toBe('asst-B')
})

test('inc4: resolveLeaf — unknown msgId returns the input unchanged', () => {
  const rows = [makeRow('a', null)]
  expect(resolveLeaf(rows, 'nonexistent')).toBe('nonexistent')
})

test('inc4: resolveLeaf — cycle-safe, does not infinite loop', () => {
  const rows = [
    makeRow('x', 'y'),
    makeRow('y', 'x'),
  ]
  expect(() => resolveLeaf(rows, 'x')).not.toThrow()
})

// ── resolveResponseLeaf ───────────────────────────────────────────────────────

test('inc6: resolveResponseLeaf — single-turn response returns itself', () => {
  const rows = [
    makeRow('u1', null, { role: 'user', responseId: 'r1' }),
    makeRow('a1', 'u1', { role: 'assistant', responseId: 'r2' }),
  ]
  expect(resolveResponseLeaf(rows, 'a1')).toBe('a1')
})

test('inc6: resolveResponseLeaf — multi-turn group returns the last turn of the same responseId', () => {
  // a1(asst,r2) → tr1(user toolResult,r2) → a2(asst,r2)  — all same responseId
  const rows = [
    makeRow('u1', null, { role: 'user', responseId: 'r1' }),
    makeRow('a1', 'u1', { role: 'assistant', responseId: 'r2' }),
    makeRow('tr1', 'a1', { role: 'user', responseId: 'r2' }),    // tool-result turn
    makeRow('a2', 'tr1', { role: 'assistant', responseId: 'r2' }),
  ]
  expect(resolveResponseLeaf(rows, 'a1')).toBe('a2')
})

test('inc6: resolveResponseLeaf — does not cross into the next response group', () => {
  // a1(r2) → tr1(r2) → a2(r2) → u2(r3) — u2 is a different response group
  const rows = [
    makeRow('u1', null, { role: 'user', responseId: 'r1' }),
    makeRow('a1', 'u1', { role: 'assistant', responseId: 'r2' }),
    makeRow('tr1', 'a1', { role: 'user', responseId: 'r2' }),
    makeRow('a2', 'tr1', { role: 'assistant', responseId: 'r2' }),
    makeRow('u2', 'a2', { role: 'user', responseId: 'r3' }),     // next exchange
    makeRow('a3', 'u2', { role: 'assistant', responseId: 'r4' }),
  ]
  expect(resolveResponseLeaf(rows, 'a1')).toBe('a2')  // stops at a2, does not follow to u2/a3
})

test('inc6: resolveResponseLeaf — unknown msgId returns input unchanged', () => {
  const rows = [makeRow('a1', null, { role: 'assistant', responseId: 'r1' })]
  expect(resolveResponseLeaf(rows, 'nonexistent')).toBe('nonexistent')
})

// ── subtreeMsgIds ─────────────────────────────────────────────────────────────

import { subtreeMsgIds } from '../../src/lib/tree'

test('inc7: subtreeMsgIds — leaf node returns just itself', () => {
  const rows = [
    makeRow('u1', null),
    makeRow('a1', 'u1'),
  ]
  expect(subtreeMsgIds(rows, 'a1')).toEqual(['a1'])
})

test('inc7: subtreeMsgIds — node with children includes all descendants', () => {
  // u1 → a1 → u2 → a2
  const rows = [
    makeRow('u1', null),
    makeRow('a1', 'u1'),
    makeRow('u2', 'a1'),
    makeRow('a2', 'u2'),
  ]
  const result = subtreeMsgIds(rows, 'a1')
  expect(result.sort()).toEqual(['a1', 'a2', 'u2'].sort())
})

test('inc7: subtreeMsgIds — siblings of root node are NOT included', () => {
  // user → asst-A (deleted subtree root)
  //      → asst-B (sibling, must survive)
  // asst-A → u2 → a2 (descendants of asst-A)
  const rows = [
    makeRow('user', null),
    makeRow('asst-A', 'user'),
    makeRow('asst-B', 'user'),
    makeRow('u2', 'asst-A'),
    makeRow('a2', 'u2'),
  ]
  const result = subtreeMsgIds(rows, 'asst-A')
  expect(result.sort()).toEqual(['asst-A', 'a2', 'u2'].sort())
  expect(result).not.toContain('user')
  expect(result).not.toContain('asst-B')
})

test('inc7: subtreeMsgIds — wide tree includes all branches under root', () => {
  // root → A → A1
  //           → A2
  //      → B
  const rows = [
    makeRow('root', null),
    makeRow('A', 'root'),
    makeRow('B', 'root'),
    makeRow('A1', 'A'),
    makeRow('A2', 'A'),
  ]
  const result = subtreeMsgIds(rows, 'root')
  expect(result.sort()).toEqual(['root', 'A', 'B', 'A1', 'A2'].sort())
})

test('inc7: subtreeMsgIds — unknown msgId returns just that id', () => {
  const rows = [makeRow('a', null)]
  expect(subtreeMsgIds(rows, 'nonexistent')).toEqual(['nonexistent'])
})

test('inc7: subtreeMsgIds — empty rows returns just the msgId', () => {
  expect(subtreeMsgIds([], 'x')).toEqual(['x'])
})

// ── pre-existing resolveLeaf tests ───────────────────────────────────────────

test('inc4: resolveLeaf — deeper fork follows last child at each level', () => {
  // user → asst-A → userA → asstA2
  //      → asst-B → userB → asstB2  (last at each fork → active path down)
  const rows = [
    makeRow('user', null),
    makeRow('asst-A', 'user'),
    makeRow('asst-B', 'user'),
    makeRow('userA', 'asst-A'),
    makeRow('userB', 'asst-B'),
    makeRow('asstA2', 'userA'),
    makeRow('asstB2', 'userB'),
  ]
  // From 'user': last child is asst-B, then last child is userB, then last is asstB2
  expect(resolveLeaf(rows, 'user')).toBe('asstB2')
  // From 'asst-A': last child is userA, then asstA2
  expect(resolveLeaf(rows, 'asst-A')).toBe('asstA2')
})

// ── mostRecentLeaf ────────────────────────────────────────────────────────────

test('mostRecentLeaf: empty rows returns null', () => {
  expect(mostRecentLeaf([])).toBeNull()
})

test('mostRecentLeaf: single linear chain returns the deepest node', () => {
  const rows = [
    makeRow('a', null),
    makeRow('b', 'a'),
    makeRow('c', 'b'),
  ]
  expect(mostRecentLeaf(rows)).toBe('c')
})

test('mostRecentLeaf: picks the most-recently-created root branch, ignoring array order', () => {
  const rows = [
    makeRow('new-root', null, { createdAt: '2025-01-02T00:00:00.000Z' }),
    makeRow('old-root', null, { createdAt: '2025-01-01T00:00:00.000Z' }),
    makeRow('old-child', 'old-root', { createdAt: '2025-01-01T00:00:01.000Z' }),
  ]
  // old-child is last in array order and deeper, but new-root's branch is more recent.
  expect(mostRecentLeaf(rows)).toBe('new-root')
})

test('mostRecentLeaf: rows with no root (headless/malformed) returns null', () => {
  const rows = [makeRow('a', 'missing-parent')]
  expect(mostRecentLeaf(rows)).toBeNull()
})

// ── resolveSafeLeaf ───────────────────────────────────────────────────────────

test('resolveSafeLeaf: empty rows returns null', () => {
  expect(resolveSafeLeaf([], 'anything')).toBeNull()
})

test('resolveSafeLeaf: valid candidate resolves down to its branch leaf', () => {
  const rows = [
    makeRow('a', null),
    makeRow('b', 'a'),
    makeRow('c', 'b'),
  ]
  expect(resolveSafeLeaf(rows, 'a')).toBe('c')
})

test('resolveSafeLeaf: null candidate falls back to mostRecentLeaf', () => {
  const rows = [makeRow('a', null), makeRow('b', 'a')]
  expect(resolveSafeLeaf(rows, null)).toBe('b')
})

test('resolveSafeLeaf: candidate referencing a non-existent (phantom) parent falls back safely', () => {
  // Reproduces the exact incident: a turn's parentId points at a message that was never
  // (or no longer) durably persisted. The old resolveLeaf would return the phantom id
  // unchanged; resolveSafeLeaf must never do that.
  const rows = [
    makeRow('real-root', null),
    makeRow('real-child', 'real-root'),
  ]
  const result = resolveSafeLeaf(rows, 'phantom-msg-id-that-does-not-exist')
  expect(result).not.toBe('phantom-msg-id-that-does-not-exist')
  expect(rows.some(r => r.msgId === result)).toBe(true)
  expect(result).toBe('real-child')
})
