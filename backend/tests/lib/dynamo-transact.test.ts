// Must declare mockSend before jest.mock factories (Jest hoists mock calls)
const mockSend = jest.fn()

jest.mock('../../src/lib/dynamo', () => {
  return jest.requireActual('../../src/lib/dynamo')
})

import { ddb, putMessagePair, putSharePair, deleteSharePair } from '../../src/lib/dynamo'

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(ddb, 'send').mockImplementation(mockSend)
})

afterEach(() => {
  jest.restoreAllMocks()
})

test('putMessagePair issues a single TransactWriteCommand with both items as Put requests', async () => {
  mockSend.mockResolvedValueOnce({})
  const assistantItem = { PK: 'CHAT#c1', SK: 'MSG#ts#0000#asst1', msgId: 'asst1', role: 'assistant' }
  const toolResultItem = { PK: 'CHAT#c1', SK: 'MSG#ts#0001#user1', msgId: 'user1', role: 'user' }

  await putMessagePair(assistantItem, toolResultItem)

  expect(mockSend).toHaveBeenCalledTimes(1)
  const call = mockSend.mock.calls[0][0]
  const transactItems = call.input.TransactItems as { Put: { Item: unknown } }[]
  expect(transactItems).toHaveLength(2)
  expect(transactItems[0]).toMatchObject({ Put: { Item: { msgId: 'asst1' } } })
  expect(transactItems[1]).toMatchObject({ Put: { Item: { msgId: 'user1' } } })
})

test('putMessagePair propagates failure — caller must treat it as all-or-nothing', async () => {
  mockSend.mockRejectedValueOnce(new Error('TransactionCanceledException'))
  const assistantItem = { PK: 'CHAT#c1', SK: 'MSG#ts#0000#asst1', msgId: 'asst1' }
  const toolResultItem = { PK: 'CHAT#c1', SK: 'MSG#ts#0001#user1', msgId: 'user1' }

  await expect(putMessagePair(assistantItem, toolResultItem)).rejects.toThrow('TransactionCanceledException')
  // Only one send call was made (the transaction itself) — there is no follow-up write
  // for the second item, confirming the pair is sent as one atomic operation, not two.
  expect(mockSend).toHaveBeenCalledTimes(1)
})

test('putSharePair issues a single TransactWriteCommand with the lookup + index items as Put requests', async () => {
  mockSend.mockResolvedValueOnce({})
  const lookupItem = { PK: 'SHARE#s1', SK: 'SHARE#s1', shareId: 's1', sub: 'user-1', chatId: 'c1' }
  const indexItem = { PK: 'CHAT#c1', SK: 'SHARE#s1', shareId: 's1' }

  await putSharePair(lookupItem, indexItem)

  expect(mockSend).toHaveBeenCalledTimes(1)
  const call = mockSend.mock.calls[0][0]
  const transactItems = call.input.TransactItems as { Put: { Item: unknown } }[]
  expect(transactItems).toHaveLength(2)
  expect(transactItems[0]).toMatchObject({ Put: { Item: { PK: 'SHARE#s1' } } })
  expect(transactItems[1]).toMatchObject({ Put: { Item: { PK: 'CHAT#c1', SK: 'SHARE#s1' } } })
})

test('deleteSharePair issues a single TransactWriteCommand deleting both the lookup and index items', async () => {
  mockSend.mockResolvedValueOnce({})

  await deleteSharePair('c1', 's1')

  expect(mockSend).toHaveBeenCalledTimes(1)
  const call = mockSend.mock.calls[0][0]
  const transactItems = call.input.TransactItems as { Delete: { Key: unknown } }[]
  expect(transactItems).toHaveLength(2)
  expect(transactItems[0]).toMatchObject({ Delete: { Key: { PK: 'SHARE#s1', SK: 'SHARE#s1' } } })
  expect(transactItems[1]).toMatchObject({ Delete: { Key: { PK: 'CHAT#c1', SK: 'SHARE#s1' } } })
})
