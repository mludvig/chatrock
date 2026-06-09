import { buildChatKey, buildMsgKey, buildConnKey, buildTurnKey } from '../../src/lib/dynamo'

test('buildChatKey returns correct PK/SK', () => {
  const k = buildChatKey('sub1', 'chat1')
  expect(k.PK).toBe('USER#sub1')
  expect(k.SK).toBe('CHAT#chat1')
})

test('buildMsgKey returns correct PK/SK', () => {
  const k = buildMsgKey('chat1', '2024-01-01T00:00:00.000Z', 'msg1')
  expect(k.PK).toBe('CHAT#chat1')
  expect(k.SK).toBe('MSG#2024-01-01T00:00:00.000Z#msg1')
})

test('buildConnKey returns correct PK/SK', () => {
  const k = buildConnKey('conn1')
  expect(k.PK).toBe('CONN#conn1')
  expect(k.SK).toBe('CONN#conn1')
})

// ── Slice 1: buildTurnKey with zero-padded seq ────────────────────────────────

test('buildTurnKey returns PK and seq-ordered SK', () => {
  const ts = '2025-06-01T12:00:00.000Z'
  const k = buildTurnKey('chat1', ts, 3, 'msg-abc')
  expect(k.PK).toBe('CHAT#chat1')
  expect(k.SK).toBe('MSG#2025-06-01T12:00:00.000Z#0003#msg-abc')
})

test('buildTurnKey zero-pads seq to 4 digits so lexical sort == numeric sort', () => {
  const ts = '2025-06-01T12:00:00.000Z'
  const k0 = buildTurnKey('chat1', ts, 0, 'a')
  const k9 = buildTurnKey('chat1', ts, 9, 'b')
  const k10 = buildTurnKey('chat1', ts, 10, 'c')
  const k100 = buildTurnKey('chat1', ts, 100, 'd')

  // All SK values under the same ts should sort in ascending numeric order
  const sks = [k100.SK, k9.SK, k0.SK, k10.SK].sort()
  expect(sks).toEqual([k0.SK, k9.SK, k10.SK, k100.SK])
})

test('buildTurnKey seq=0 produces 0000 padding', () => {
  const k = buildTurnKey('chat1', '2025-01-01T00:00:00.000Z', 0, 'x')
  expect(k.SK).toContain('#0000#')
})

test('buildTurnKey seq=9999 at boundary', () => {
  const k = buildTurnKey('chat1', '2025-01-01T00:00:00.000Z', 9999, 'x')
  expect(k.SK).toContain('#9999#')
})
