const mockSend = jest.fn()
jest.mock('../../src/lib/dynamo', () => jest.requireActual('../../src/lib/dynamo'))
import { ddb, setChatStreaming, buildChatKey } from '../../src/lib/dynamo'
import { UpdateCommand } from '@aws-sdk/lib-dynamodb'

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(ddb, 'send').mockImplementation(mockSend)
})
afterEach(() => jest.restoreAllMocks())

test('setChatStreaming with a deadline sets streamingDeadlineAt', async () => {
  mockSend.mockResolvedValue({})
  await setChatStreaming('user-1', 'chat-abc', 'resp-1', 12345)
  expect(mockSend).toHaveBeenCalledTimes(1)
  const cmd = mockSend.mock.calls[0][0]
  expect(cmd).toBeInstanceOf(UpdateCommand)
  expect(cmd.input.Key).toEqual(buildChatKey('user-1', 'chat-abc'))
  expect(cmd.input.UpdateExpression).toContain('streamingDeadlineAt = :d')
  expect(cmd.input.ExpressionAttributeValues[':d']).toBe(12345)
})

test('setChatStreaming without a deadline removes any stale streamingDeadlineAt', async () => {
  mockSend.mockResolvedValue({})
  await setChatStreaming('user-1', 'chat-abc', 'resp-1')
  expect(mockSend).toHaveBeenCalledTimes(1)
  const cmd = mockSend.mock.calls[0][0]
  expect(cmd).toBeInstanceOf(UpdateCommand)
  expect(cmd.input.UpdateExpression).toMatch(/REMOVE\s+streamingDeadlineAt/)
  expect(cmd.input.ExpressionAttributeValues).not.toHaveProperty(':d')
})
