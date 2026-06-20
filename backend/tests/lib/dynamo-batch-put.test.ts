// Must declare mockSend before jest.mock factories (Jest hoists mock calls)
const mockSend = jest.fn()

jest.mock('../../src/lib/dynamo', () => {
  return jest.requireActual('../../src/lib/dynamo')
})

import { ddb, batchPutMessages, TABLE } from '../../src/lib/dynamo'

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(ddb, 'send').mockImplementation(mockSend)
})

afterEach(() => {
  jest.restoreAllMocks()
})

test('batchPutMessages with 0 items issues no send calls', async () => {
  await batchPutMessages([])
  expect(mockSend).not.toHaveBeenCalled()
})

test('batchPutMessages with 3 items issues one BatchWriteCommand with PutRequests', async () => {
  mockSend.mockResolvedValueOnce({})
  const items = [
    { PK: 'CHAT#c1', SK: 'MSG#ts#0000#a', msgId: 'a' },
    { PK: 'CHAT#c1', SK: 'MSG#ts#0001#b', msgId: 'b' },
    { PK: 'CHAT#c1', SK: 'MSG#ts#0002#c', msgId: 'c' },
  ]
  await batchPutMessages(items)

  expect(mockSend).toHaveBeenCalledTimes(1)
  const call = mockSend.mock.calls[0][0]
  const requests = Object.values(call.input.RequestItems)[0] as { PutRequest: { Item: unknown } }[]
  expect(requests).toHaveLength(3)
  expect(requests[0]).toMatchObject({ PutRequest: { Item: { msgId: 'a' } } })
  expect(requests[2]).toMatchObject({ PutRequest: { Item: { msgId: 'c' } } })
})

test('batchPutMessages batches 26 items into 2 BatchWriteCommand calls (25 + 1)', async () => {
  mockSend.mockResolvedValue({})
  const items = Array.from({ length: 26 }, (_, i) => ({
    PK: 'CHAT#c1',
    SK: `MSG#ts#${String(i).padStart(4, '0')}#msg${i}`,
    msgId: `msg${i}`,
  }))
  await batchPutMessages(items)

  expect(mockSend).toHaveBeenCalledTimes(2)

  // First batch: 25 PutRequests
  const firstRequests = Object.values(mockSend.mock.calls[0][0].input.RequestItems)[0] as unknown[]
  expect(firstRequests).toHaveLength(25)

  // Second batch: 1 PutRequest
  const secondRequests = Object.values(mockSend.mock.calls[1][0].input.RequestItems)[0] as unknown[]
  expect(secondRequests).toHaveLength(1)
})

// ── UnprocessedItems retry ────────────────────────────────────────────────────
//
// BatchWriteCommand is not atomic — a throttled/partial response returns the leftover
// items in UnprocessedItems without throwing. Silently ignoring that would leave a fork
// half-copied with no error. batchPutMessages must retry until clear, or throw.

test('batchPutMessages retries UnprocessedItems until they clear', async () => {
  const itemB = { PK: 'CHAT#c1', SK: 'MSG#ts#0001#b', msgId: 'b' }
  mockSend
    .mockResolvedValueOnce({ UnprocessedItems: { [TABLE]: [{ PutRequest: { Item: itemB } }] } })
    .mockResolvedValueOnce({})

  await batchPutMessages([{ PK: 'CHAT#c1', SK: 'MSG#ts#0000#a', msgId: 'a' }, itemB])

  expect(mockSend).toHaveBeenCalledTimes(2)
  // The retry resends exactly the unprocessed item, not the whole original batch
  const retryRequests = Object.values(mockSend.mock.calls[1][0].input.RequestItems)[0] as { PutRequest: { Item: unknown } }[]
  expect(retryRequests).toHaveLength(1)
  expect(retryRequests[0]).toMatchObject({ PutRequest: { Item: { msgId: 'b' } } })
})

test('batchPutMessages throws if items remain unprocessed after all retry attempts', async () => {
  const itemA = { PK: 'CHAT#c1', SK: 'MSG#ts#0000#a', msgId: 'a' }
  mockSend.mockResolvedValue({ UnprocessedItems: { [TABLE]: [{ PutRequest: { Item: itemA } }] } })

  await expect(batchPutMessages([itemA])).rejects.toThrow(/unprocessed/)
}, 10_000)
