const mockSend = jest.fn()
jest.mock('../../src/lib/dynamo', () => jest.requireActual('../../src/lib/dynamo'))
import { ddb, setChatStreaming, buildChatKey, claimChatStreaming, queueChatMessage, takePendingMessages, releaseChatStreaming } from '../../src/lib/dynamo'
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

const conditionFailed = () => Object.assign(new Error('failed'), { name: 'ConditionalCheckFailedException' })
const msg = { content: 'hi', sentAt: '2026-10-09T00:00:00.000Z', model: 'm', systemPrompt: '', modelSettings: {}, connId: 'c' }

test('claimChatStreaming only takes an absent or stale marker', async () => {
  mockSend.mockResolvedValueOnce({}).mockRejectedValueOnce(conditionFailed())
  expect(await claimChatStreaming('user-1', 'chat-abc', 'resp-1')).toBe(true)
  expect(await claimChatStreaming('user-1', 'chat-abc', 'resp-2')).toBe(false)
  const cmd = mockSend.mock.calls[0][0]
  expect(cmd.input.ConditionExpression).toBe('attribute_not_exists(streamingSince) OR streamingSince < :cutoff')
  expect(Date.parse(cmd.input.ExpressionAttributeValues[':cutoff'])).toBeLessThan(Date.now() - 15 * 60 * 1000)
})

test('queueChatMessage appends only while a fresh marker exists', async () => {
  mockSend.mockResolvedValueOnce({}).mockRejectedValueOnce(conditionFailed())
  expect(await queueChatMessage('user-1', 'chat-abc', msg)).toBe(true)
  expect(await queueChatMessage('user-1', 'chat-abc', msg)).toBe(false)
  const cmd = mockSend.mock.calls[0][0]
  expect(cmd.input.UpdateExpression).toContain('list_append(if_not_exists(pendingMessages, :empty), :m)')
  expect(cmd.input.ConditionExpression).toBe('streamingSince >= :cutoff')
  expect(cmd.input.ExpressionAttributeValues[':m']).toEqual([msg])
})

test('takePendingMessages returns the removed queue, or nothing when empty', async () => {
  mockSend.mockResolvedValueOnce({ Attributes: { pendingMessages: [msg] } }).mockRejectedValueOnce(conditionFailed())
  expect(await takePendingMessages('user-1', 'chat-abc')).toEqual([msg])
  expect(await takePendingMessages('user-1', 'chat-abc')).toEqual([])
  expect(mockSend.mock.calls[0][0].input.ReturnValues).toBe('UPDATED_OLD')
})

test('releaseChatStreaming refuses while messages are queued', async () => {
  mockSend.mockResolvedValueOnce({}).mockRejectedValueOnce(conditionFailed())
  expect(await releaseChatStreaming('user-1', 'chat-abc')).toBe(true)
  expect(await releaseChatStreaming('user-1', 'chat-abc')).toBe(false)
  expect(mockSend.mock.calls[0][0].input.ConditionExpression).toBe('attribute_not_exists(pendingMessages)')
})

test('a non-condition error propagates', async () => {
  mockSend.mockRejectedValueOnce(new Error('throttled'))
  await expect(claimChatStreaming('user-1', 'chat-abc', 'r')).rejects.toThrow('throttled')
})
