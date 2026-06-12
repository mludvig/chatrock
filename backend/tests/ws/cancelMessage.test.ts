import { handler } from '../../src/ws/cancelMessage'
import * as dynamo from '../../src/lib/dynamo'

jest.mock('../../src/lib/dynamo', () => ({
  ...jest.requireActual('../../src/lib/dynamo'),
  getConnection: jest.fn(),
  setStreamCancel: jest.fn(),
}))

const mockDynamo = dynamo as jest.Mocked<typeof dynamo>

const makeEvent = (connId = 'conn-1') => ({
  requestContext: { connectionId: connId },
  body: '{}',
})

beforeEach(() => jest.clearAllMocks())

test('sets cancel flag and returns 200 when connection exists', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1' })
  mockDynamo.setStreamCancel.mockResolvedValue(undefined)

  const res = await handler(makeEvent())

  expect((res as { statusCode: number }).statusCode).toBe(200)
  expect(mockDynamo.setStreamCancel).toHaveBeenCalledWith('conn-1')
})

test('returns 410 when connection not found', async () => {
  mockDynamo.getConnection.mockResolvedValue(undefined)

  const res = await handler(makeEvent('conn-gone'))

  expect((res as { statusCode: number }).statusCode).toBe(410)
  expect(mockDynamo.setStreamCancel).not.toHaveBeenCalled()
})
