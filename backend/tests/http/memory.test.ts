import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { handler } from '../../src/http/memory'
import * as dynamo from '../../src/lib/dynamo'

jest.mock('../../src/lib/dynamo')

const mockDynamo = dynamo as jest.Mocked<typeof dynamo>

beforeEach(() => jest.clearAllMocks())

const makeEvent = (
  method: string,
  path: string,
  pathParameters: Record<string, string> = {},
) => ({
  requestContext: {
    authorizer: { jwt: { claims: { sub: 'user-1' } } },
  },
  routeKey: `${method} ${path}`,
  pathParameters,
  body: undefined,
})

const result = (r: unknown) => r as APIGatewayProxyStructuredResultV2

// ── GET /api/memory ──────────────────────────────────────────────────────────

test('GET /api/memory returns memory list mapped correctly', async () => {
  mockDynamo.listUserMemories.mockResolvedValue([
    {
      PK: 'USER#user-1',
      SK: 'MEM#USER#mem-1',
      memId: 'mem-1',
      text: 'User is from New Zealand',
      category: 'identity',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      PK: 'USER#user-1',
      SK: 'MEM#USER#mem-2',
      memId: 'mem-2',
      text: 'User prefers dark mode',
      category: 'preference',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
  ])

  const res = result(await handler(makeEvent('GET', '/api/memory') as any))
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body ?? '{}')
  expect(body.memories).toHaveLength(2)
  expect(body.memories[0]).toEqual({
    memId: 'mem-1',
    text: 'User is from New Zealand',
    category: 'identity',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  expect(body.memories[1]).toEqual({
    memId: 'mem-2',
    text: 'User prefers dark mode',
    category: 'preference',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  })
  expect(mockDynamo.listUserMemories).toHaveBeenCalledWith('user-1')
})

test('GET /api/memory returns empty array when no memories', async () => {
  mockDynamo.listUserMemories.mockResolvedValue([])

  const res = result(await handler(makeEvent('GET', '/api/memory') as any))
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body ?? '{}')
  expect(body.memories).toEqual([])
})

// ── DELETE /api/memory/{memId} ───────────────────────────────────────────────

test('DELETE /api/memory/{memId} calls deleteUserMemory with correct sub+memId, returns 204', async () => {
  mockDynamo.deleteUserMemory.mockResolvedValue(undefined)

  const res = result(
    await handler(makeEvent('DELETE', '/api/memory/{memId}', { memId: 'mem-abc' }) as any),
  )
  expect(res.statusCode).toBe(204)
  expect(res.body).toBeFalsy()
  expect(mockDynamo.deleteUserMemory).toHaveBeenCalledWith('user-1', 'mem-abc')
})

test('DELETE /api/memory/{memId} with missing memId returns 400', async () => {
  const res = result(
    await handler(makeEvent('DELETE', '/api/memory/{memId}', {}) as any),
  )
  expect(res.statusCode).toBe(400)
  expect(mockDynamo.deleteUserMemory).not.toHaveBeenCalled()
})
