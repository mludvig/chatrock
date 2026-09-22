import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { handler } from '../../src/http/preferences'
import * as dynamo from '../../src/lib/dynamo'

jest.mock('../../src/lib/dynamo')

const mockDynamo = dynamo as jest.Mocked<typeof dynamo>

beforeEach(() => jest.clearAllMocks())

const makeEvent = (
  method: string,
  path: string,
  body?: object,
) => ({
  requestContext: {
    authorizer: { jwt: { claims: { sub: 'user-1' } } },
  },
  routeKey: `${method} ${path}`,
  pathParameters: {},
  body: body ? JSON.stringify(body) : undefined,
})

const result = (r: unknown) => r as APIGatewayProxyStructuredResultV2

// ── GET /api/preferences ─────────────────────────────────────────────────────

test('GET /api/preferences with stored prefs returns them', async () => {
  mockDynamo.getUserPrefs.mockResolvedValue({ persona: 'Be brief', webSearchEnabled: false })

  const res = result(await handler(makeEvent('GET', '/api/preferences') as any))
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body ?? '{}')
  expect(body.preferences).toEqual({ persona: 'Be brief', webSearchEnabled: false })
  expect(mockDynamo.getUserPrefs).toHaveBeenCalledWith('user-1')
})

test('GET /api/preferences with no stored prefs returns {}', async () => {
  mockDynamo.getUserPrefs.mockResolvedValue({})

  const res = result(await handler(makeEvent('GET', '/api/preferences') as any))
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body ?? '{}')
  expect(body.preferences).toEqual({})
})

test('GET /api/preferences reads a retired defaultModel as its successor, or drops it when it has none', async () => {
  mockDynamo.getUserPrefs.mockResolvedValueOnce({ defaultModel: 'global.anthropic.claude-opus-5', persona: 'x' })
  let body = JSON.parse(result(await handler(makeEvent('GET', '/api/preferences') as any)).body ?? '{}')
  expect(body.preferences).toEqual({ defaultModel: 'global.anthropic.claude-opus-5-5', persona: 'x' })

  mockDynamo.getUserPrefs.mockResolvedValueOnce({ defaultModel: 'no.such.model', persona: 'x' })
  body = JSON.parse(result(await handler(makeEvent('GET', '/api/preferences') as any)).body ?? '{}')
  expect(body.preferences).toEqual({ persona: 'x' })
  expect(mockDynamo.putUserPrefs).not.toHaveBeenCalled()
})

// ── PUT /api/preferences ─────────────────────────────────────────────────────

test('PUT /api/preferences calls putUserPrefs with correct sub + body, returns { ok: true }', async () => {
  mockDynamo.putUserPrefs.mockResolvedValue(undefined)

  const prefs = { persona: 'You are a pirate', injectCurrentDate: true, answerLength: 'short' as const }
  const res = result(await handler(makeEvent('PUT', '/api/preferences', prefs) as any))
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body ?? '{}')
  expect(body.ok).toBe(true)
  expect(mockDynamo.putUserPrefs).toHaveBeenCalledWith('user-1', prefs)
})

test('PUT /api/preferences with empty body still calls putUserPrefs', async () => {
  mockDynamo.putUserPrefs.mockResolvedValue(undefined)

  const res = result(await handler(makeEvent('PUT', '/api/preferences', {}) as any))
  expect(res.statusCode).toBe(200)
  expect(mockDynamo.putUserPrefs).toHaveBeenCalledWith('user-1', {})
})
