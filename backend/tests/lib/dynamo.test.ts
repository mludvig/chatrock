const mockSend = jest.fn()
jest.mock('../../src/lib/dynamo', () => jest.requireActual('../../src/lib/dynamo'))
import {
  buildChatKey, buildMsgKey, buildConnKey, buildTurnKey, ddb, listMessages,
  buildUserPrefKey, getUserPrefs, putUserPrefs,
  buildUserMemKey, listUserMemories, putUserMemory, deleteUserMemory,
} from '../../src/lib/dynamo'

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(ddb, 'send').mockImplementation(mockSend)
})
afterEach(() => jest.restoreAllMocks())

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

// ── listMessages pagination ────────────────────────────────────────────────────

test('listMessages paginates via LastEvaluatedKey until exhausted', async () => {
  const page1 = { PK: 'CHAT#c1', SK: 'MSG#ts#0000#msg-1' }
  const page2 = { PK: 'CHAT#c1', SK: 'MSG#ts#0001#msg-2' }

  mockSend
    .mockResolvedValueOnce({ Items: [page1], LastEvaluatedKey: { PK: 'CHAT#c1', SK: page1.SK } })
    .mockResolvedValueOnce({ Items: [page2] })  // no LastEvaluatedKey → done

  const result = await listMessages('c1')

  expect(result).toHaveLength(2)
  expect((result[0] as typeof page1).SK).toBe(page1.SK)
  expect((result[1] as typeof page2).SK).toBe(page2.SK)

  expect(mockSend).toHaveBeenCalledTimes(2)
  // Second call must include ExclusiveStartKey
  const secondCall = mockSend.mock.calls[1][0]
  expect(secondCall.input.ExclusiveStartKey).toEqual({ PK: 'CHAT#c1', SK: page1.SK })
})

test('listMessages returns all items when no pagination needed', async () => {
  const item = { PK: 'CHAT#c2', SK: 'MSG#ts#0000#msg-only' }
  mockSend.mockResolvedValueOnce({ Items: [item] })

  const result = await listMessages('c2')
  expect(result).toHaveLength(1)
  expect(mockSend).toHaveBeenCalledTimes(1)
})

test('listMessages returns [] for empty table', async () => {
  mockSend.mockResolvedValueOnce({ Items: [] })
  const result = await listMessages('empty-chat')
  expect(result).toHaveLength(0)
})

// ── User preferences helpers ──────────────────────────────────────────────────

test('buildUserPrefKey returns correct PK/SK', () => {
  const k = buildUserPrefKey('sub123')
  expect(k.PK).toBe('USER#sub123')
  expect(k.SK).toBe('PREF#USER')
})

test('getUserPrefs returns parsed prefs object when item exists', async () => {
  const stored = { persona: 'Be brief', answerLength: 'short' }
  mockSend.mockResolvedValueOnce({ Item: { PK: 'USER#sub1', SK: 'PREF#USER', prefs: stored } })

  const result = await getUserPrefs('sub1')
  expect(result).toEqual(stored)
  const call = mockSend.mock.calls[0][0]
  expect(call.input.TableName).toBeDefined()
  expect(call.input.Key).toEqual({ PK: 'USER#sub1', SK: 'PREF#USER' })
})

test('getUserPrefs returns {} when item does not exist', async () => {
  mockSend.mockResolvedValueOnce({ Item: undefined })
  const result = await getUserPrefs('sub-missing')
  expect(result).toEqual({})
})

test('getUserPrefs returns {} when item has no prefs field', async () => {
  mockSend.mockResolvedValueOnce({ Item: { PK: 'USER#sub1', SK: 'PREF#USER' } })
  const result = await getUserPrefs('sub1')
  expect(result).toEqual({})
})

test('putUserPrefs calls PutCommand with correct key, prefs, and updatedAt', async () => {
  mockSend.mockResolvedValueOnce({})
  const prefs = { persona: 'Helpful assistant', webSearchEnabled: true }
  await putUserPrefs('sub2', prefs)

  expect(mockSend).toHaveBeenCalledTimes(1)
  const call = mockSend.mock.calls[0][0]
  expect(call.input.TableName).toBeDefined()
  expect(call.input.Item.PK).toBe('USER#sub2')
  expect(call.input.Item.SK).toBe('PREF#USER')
  expect(call.input.Item.prefs).toEqual(prefs)
  expect(typeof call.input.Item.updatedAt).toBe('string')
  // updatedAt should be a valid ISO timestamp
  expect(() => new Date(call.input.Item.updatedAt)).not.toThrow()
})

test('putUserPrefs accepts empty prefs object', async () => {
  mockSend.mockResolvedValueOnce({})
  await putUserPrefs('sub3', {})
  const call = mockSend.mock.calls[0][0]
  expect(call.input.Item.prefs).toEqual({})
})

// ── User memory helpers ───────────────────────────────────────────────────────

test('buildUserMemKey returns correct PK and MEM#USER# prefixed SK', () => {
  const k = buildUserMemKey('sub123', 'mem-uuid-1')
  expect(k.PK).toBe('USER#sub123')
  expect(k.SK).toBe('MEM#USER#mem-uuid-1')
})

test('listUserMemories queries MEM#USER# prefix in user partition', async () => {
  const item1 = { PK: 'USER#sub1', SK: 'MEM#USER#aaa', text: 'I live in Berlin', category: 'identity' }
  const item2 = { PK: 'USER#sub1', SK: 'MEM#USER#bbb', text: 'I prefer concise answers', category: 'preference' }
  mockSend.mockResolvedValueOnce({ Items: [item1, item2] })

  const result = await listUserMemories('sub1')

  expect(result).toHaveLength(2)
  expect(result[0]).toEqual(item1)
  expect(result[1]).toEqual(item2)

  const call = mockSend.mock.calls[0][0]
  expect(call.input.TableName).toBeDefined()
  expect(call.input.KeyConditionExpression).toContain('begins_with')
  expect(call.input.ExpressionAttributeValues[':pk']).toBe('USER#sub1')
  expect(call.input.ExpressionAttributeValues[':prefix']).toBe('MEM#USER#')
})

test('listUserMemories returns [] when no items found', async () => {
  mockSend.mockResolvedValueOnce({ Items: [] })
  const result = await listUserMemories('sub-empty')
  expect(result).toEqual([])
})

test('listUserMemories returns [] when Items is undefined', async () => {
  mockSend.mockResolvedValueOnce({})
  const result = await listUserMemories('sub-undef')
  expect(result).toEqual([])
})

test('listUserMemories uses ScanIndexForward true (ascending SK order)', async () => {
  mockSend.mockResolvedValueOnce({ Items: [] })
  await listUserMemories('sub1')
  const call = mockSend.mock.calls[0][0]
  expect(call.input.ScanIndexForward).toBe(true)
})

test('putUserMemory calls PutCommand with the provided item', async () => {
  mockSend.mockResolvedValueOnce({})
  const item = {
    PK: 'USER#sub1',
    SK: 'MEM#USER#mem-xyz',
    memId: 'mem-xyz',
    text: 'I am a software engineer',
    category: 'identity',
    createdAt: '2026-06-14T00:00:00.000Z',
    updatedAt: '2026-06-14T00:00:00.000Z',
  }
  await putUserMemory(item)

  expect(mockSend).toHaveBeenCalledTimes(1)
  const call = mockSend.mock.calls[0][0]
  expect(call.input.TableName).toBeDefined()
  expect(call.input.Item).toEqual(item)
})

test('deleteUserMemory calls DeleteCommand with correct key', async () => {
  mockSend.mockResolvedValueOnce({})
  await deleteUserMemory('sub1', 'mem-abc')

  expect(mockSend).toHaveBeenCalledTimes(1)
  const call = mockSend.mock.calls[0][0]
  expect(call.input.TableName).toBeDefined()
  expect(call.input.Key).toEqual({ PK: 'USER#sub1', SK: 'MEM#USER#mem-abc' })
})
