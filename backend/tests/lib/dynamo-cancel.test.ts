const mockSend = jest.fn()
jest.mock('../../src/lib/dynamo', () => jest.requireActual('../../src/lib/dynamo'))
import { ddb, setStreamCancel, isStreamCancelled, clearStreamCancel, buildConnKey } from '../../src/lib/dynamo'
import { UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb'

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(ddb, 'send').mockImplementation(mockSend)
})
afterEach(() => jest.restoreAllMocks())

test('setStreamCancel issues UpdateCommand setting cancelRequested=true on the conn key', async () => {
  mockSend.mockResolvedValue({})
  await setStreamCancel('conn-abc')
  expect(mockSend).toHaveBeenCalledTimes(1)
  const cmd = mockSend.mock.calls[0][0]
  expect(cmd).toBeInstanceOf(UpdateCommand)
  expect(cmd.input.Key).toEqual(buildConnKey('conn-abc'))
  expect(cmd.input.UpdateExpression).toContain('cancelRequested')
  expect(cmd.input.ExpressionAttributeValues[':v']).toBe(true)
})

test('isStreamCancelled returns true when cancelRequested=true in the item', async () => {
  mockSend.mockResolvedValue({ Item: { ...buildConnKey('conn-x'), cancelRequested: true } })
  const result = await isStreamCancelled('conn-x')
  expect(result).toBe(true)
  const cmd = mockSend.mock.calls[0][0]
  expect(cmd).toBeInstanceOf(GetCommand)
  expect(cmd.input.Key).toEqual(buildConnKey('conn-x'))
})

test('isStreamCancelled returns false when cancelRequested is absent', async () => {
  mockSend.mockResolvedValue({ Item: { ...buildConnKey('conn-y') } })
  expect(await isStreamCancelled('conn-y')).toBe(false)
})

test('isStreamCancelled returns false when item does not exist', async () => {
  mockSend.mockResolvedValue({})
  expect(await isStreamCancelled('conn-gone')).toBe(false)
})

test('clearStreamCancel issues UpdateCommand removing cancelRequested', async () => {
  mockSend.mockResolvedValue({})
  await clearStreamCancel('conn-abc')
  expect(mockSend).toHaveBeenCalledTimes(1)
  const cmd = mockSend.mock.calls[0][0]
  expect(cmd).toBeInstanceOf(UpdateCommand)
  expect(cmd.input.Key).toEqual(buildConnKey('conn-abc'))
  expect(cmd.input.UpdateExpression).toMatch(/REMOVE.*cancelRequested/)
})
