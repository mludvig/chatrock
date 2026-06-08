import { buildChatKey, buildMsgKey, buildConnKey } from '../../src/lib/dynamo'

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
