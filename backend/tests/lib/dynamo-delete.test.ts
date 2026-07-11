// Must declare mockSend before jest.mock factories (Jest hoists mock calls)
const mockSend = jest.fn()

jest.mock('../../src/lib/dynamo', () => {
  return jest.requireActual('../../src/lib/dynamo')
})

// Spy on the ddb object exported from the module
import { ddb, deleteChatMessages, deleteChatItem, batchDeleteMessages, TABLE } from '../../src/lib/dynamo'

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(ddb, 'send').mockImplementation(mockSend)
})

afterEach(() => {
  jest.restoreAllMocks()
})

// deleteChatMessages and deleteChatItem are separate, independently-callable steps (not a
// single cascade) — the stream-triggered cleanup Lambda calls deleteChatMessages on its own,
// after the Chat item is already gone, and must never re-attempt deleting it.

test('deleteChatMessages deletes all message items for a chat', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [
      { PK: 'CHAT#c1', SK: 'MSG#2025-01-01T00:00:00.000Z#0000#msg1' },
      { PK: 'CHAT#c1', SK: 'MSG#2025-01-01T00:00:00.000Z#0001#msg2' },
    ],
  })
  mockSend.mockResolvedValueOnce({})

  await deleteChatMessages('c1')

  expect(mockSend).toHaveBeenCalledTimes(2) // Query + 1 BatchWrite
})

test('deleteChatMessages with no messages only issues a Query', async () => {
  mockSend.mockResolvedValueOnce({ Items: [] })

  await deleteChatMessages('empty-chat')

  expect(mockSend).toHaveBeenCalledTimes(1)
})

test('deleteChatMessages batches more than 25 messages in chunks of 25', async () => {
  const items = Array.from({ length: 26 }, (_, i) => ({
    PK: 'CHAT#c1',
    SK: `MSG#ts#${String(i).padStart(4, '0')}#msg${i}`,
  }))
  mockSend.mockResolvedValueOnce({ Items: items })
  mockSend.mockResolvedValue({})

  await deleteChatMessages('c1')

  // Query + 2 BatchWrites = 3 sends
  expect(mockSend).toHaveBeenCalledTimes(3)
})

test('deleteChatItem issues a single DeleteCommand on the chat key', async () => {
  mockSend.mockResolvedValueOnce({})

  await deleteChatItem('user-1', 'c1')

  expect(mockSend).toHaveBeenCalledTimes(1)
  const call = mockSend.mock.calls[0][0]
  expect(call.input.Key).toEqual({ PK: 'USER#user-1', SK: 'CHAT#c1' })
})

// ── UnprocessedItems retry (subtree delete) ──────────────────────────────────
//
// A throttled/partial BatchWriteCommand response leaves leftover DeleteRequests in
// UnprocessedItems without throwing — silently ignoring that would leave a "deleted"
// branch half-deleted. batchDeleteMessages must retry until clear, or throw.

test('batchDeleteMessages retries UnprocessedItems until they clear', async () => {
  const keyB = { PK: 'CHAT#c1', SK: 'MSG#ts#0001#b' }
  mockSend
    .mockResolvedValueOnce({ UnprocessedItems: { [TABLE]: [{ DeleteRequest: { Key: keyB } }] } })
    .mockResolvedValueOnce({})

  await batchDeleteMessages([{ PK: 'CHAT#c1', SK: 'MSG#ts#0000#a' }, keyB])

  expect(mockSend).toHaveBeenCalledTimes(2)
  const retryRequests = Object.values(mockSend.mock.calls[1][0].input.RequestItems)[0] as { DeleteRequest: { Key: unknown } }[]
  expect(retryRequests).toHaveLength(1)
  expect(retryRequests[0]).toMatchObject({ DeleteRequest: { Key: keyB } })
})

test('batchDeleteMessages throws if items remain unprocessed after all retry attempts', async () => {
  const keyA = { PK: 'CHAT#c1', SK: 'MSG#ts#0000#a' }
  mockSend.mockResolvedValue({ UnprocessedItems: { [TABLE]: [{ DeleteRequest: { Key: keyA } }] } })

  await expect(batchDeleteMessages([keyA])).rejects.toThrow(/unprocessed/)
}, 10_000)
