const mockSend = jest.fn()

jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PostToConnectionCommand: jest.fn().mockImplementation(input => ({ input })),
}))

import { notifyConnection } from '../../src/lib/wsNotify'

beforeEach(() => jest.clearAllMocks())

test('notifyConnection — posts the JSON-encoded data to the given connection', async () => {
  mockSend.mockResolvedValue({})

  await notifyConnection('conn-1', { type: 'research_plan', runId: 'run-1' })

  expect(mockSend).toHaveBeenCalledTimes(1)
  const call = mockSend.mock.calls[0][0]
  expect(call.input.ConnectionId).toBe('conn-1')
  expect(JSON.parse(call.input.Data)).toEqual({ type: 'research_plan', runId: 'run-1' })
})

test('notifyConnection — no-ops when connId is undefined', async () => {
  await notifyConnection(undefined, { type: 'research_plan' })

  expect(mockSend).not.toHaveBeenCalled()
})

test('notifyConnection — swallows a failure (e.g. dead/expired connection)', async () => {
  mockSend.mockRejectedValue(new Error('410 Gone'))

  await expect(notifyConnection('conn-1', { type: 'research_done' })).resolves.toBeUndefined()
})
