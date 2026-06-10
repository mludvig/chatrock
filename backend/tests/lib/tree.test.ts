/**
 * Tests for lib/tree.ts — buildActivePath
 *
 * buildActivePath(rows, activeLeafId) walks leaf→root via parentId, reverses
 * to root→leaf order, and returns only the active branch's rows.
 */
import { buildActivePath, resolveLeaf } from '../../src/lib/tree'

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

test('null activeLeafId: falls back to the last row (by array order)', () => {
  const rows = [
    makeRow('msg-a', null),
    makeRow('msg-b', 'msg-a'),
  ]
  const result = buildActivePath(rows, null)
  expect(result.map(r => r.msgId)).toEqual(['msg-a', 'msg-b'])
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

test('unresolvable activeLeafId: falls back to full array (last row as leaf)', () => {
  const rows = [
    makeRow('msg-1', null),
    makeRow('msg-2', 'msg-1'),
  ]
  // 'nonexistent' is not in the rows — should fall back gracefully
  const result = buildActivePath(rows, 'nonexistent')
  // Falls back to last-row leaf walk → same as linear chain
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
