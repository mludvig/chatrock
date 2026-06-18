// Must declare mockSend before jest.mock factories (Jest hoists mock calls)
const mockSend = jest.fn()

jest.mock('../../src/lib/dynamo', () => {
  // Import the real module but replace the `ddb` client's send with our mock.
  // We re-export everything real, then override only `deleteChat` ... actually
  // the simplest approach: mock the ddb instance inside the module.
  // We can't do that here — use a different strategy: mock at the DDB client level.
  return jest.requireActual('../../src/lib/dynamo')
})

// Instead, spy on the ddb object exported from the module
import { ddb, deleteChat, batchDeleteMessages, TABLE } from '../../src/lib/dynamo'

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(ddb, 'send').mockImplementation(mockSend)
})

afterEach(() => {
  jest.restoreAllMocks()
})

test('deleteChat deletes all messages before deleting the chat record', async () => {
  // First send: QueryCommand returns 2 message items
  mockSend.mockResolvedValueOnce({
    Items: [
      { PK: 'CHAT#c1', SK: 'MSG#2025-01-01T00:00:00.000Z#0000#msg1' },
      { PK: 'CHAT#c1', SK: 'MSG#2025-01-01T00:00:00.000Z#0001#msg2' },
    ],
  })
  // Second send: BatchWriteCommand for the 2 messages
  mockSend.mockResolvedValueOnce({})
  // Third send: DeleteCommand for the chat metadata
  mockSend.mockResolvedValueOnce({})

  await deleteChat('user-1', 'c1')

  expect(mockSend).toHaveBeenCalledTimes(3)

  // Third call must be DeleteCommand on the chat key (not a message key)
  const lastCall = mockSend.mock.calls[2][0]
  expect(lastCall.input.Key).toEqual({ PK: 'USER#user-1', SK: 'CHAT#c1' })
})

test('deleteChat with no messages only issues Query + DeleteCommand', async () => {
  // QueryCommand returns empty
  mockSend.mockResolvedValueOnce({ Items: [] })
  // DeleteCommand for the chat metadata
  mockSend.mockResolvedValueOnce({})

  await deleteChat('user-1', 'empty-chat')

  // Query + Delete = 2 sends; no BatchWrite since no messages
  expect(mockSend).toHaveBeenCalledTimes(2)
  const lastCall = mockSend.mock.calls[1][0]
  expect(lastCall.input.Key).toEqual({ PK: 'USER#user-1', SK: 'CHAT#empty-chat' })
})

test('deleteChat batches more than 25 messages in chunks of 25', async () => {
  // 26 messages — should produce 2 BatchWrite calls
  const items = Array.from({ length: 26 }, (_, i) => ({
    PK: 'CHAT#c1',
    SK: `MSG#ts#${String(i).padStart(4, '0')}#msg${i}`,
  }))
  mockSend.mockResolvedValueOnce({ Items: items })
  mockSend.mockResolvedValue({}) // all subsequent calls succeed

  await deleteChat('user-1', 'c1')

  // Query + 2 BatchWrites + 1 Delete = 4 sends
  expect(mockSend).toHaveBeenCalledTimes(4)
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
