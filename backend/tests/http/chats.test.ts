import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { handler } from '../../src/http/chats'
import * as dynamo from '../../src/lib/dynamo'

jest.mock('../../src/lib/dynamo')
const mockDynamo = dynamo as jest.Mocked<typeof dynamo>

beforeEach(() => jest.clearAllMocks())


const makeEvent = (
  method: string,
  path: string,
  body?: object,
  pathParams?: Record<string, string>,
) => ({
  requestContext: {
    authorizer: { jwt: { claims: { sub: 'user-1' } } },
  },
  routeKey: `${method} ${path}`,
  pathParameters: pathParams ?? {},
  body: body ? JSON.stringify(body) : undefined,
})

const result = (r: unknown) => r as APIGatewayProxyStructuredResultV2

test('GET /api/chats returns chat list', async () => {
  mockDynamo.listChats.mockResolvedValue([
    { PK: 'USER#user-1', SK: 'CHAT#c1', title: 'Hello', model: 'x', systemPrompt: '', createdAt: '', updatedAt: '' },
  ])
  const res = result(await handler(makeEvent('GET', '/api/chats') as any))
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body ?? '{}')
  expect(body.chats).toHaveLength(1)
  expect(body.chats[0].chatId).toBe('c1')
  expect(body.chats[0].title).toBe('Hello')
})

test('inc2: GET /api/chats includes activeLeafId in each chat', async () => {
  mockDynamo.listChats.mockResolvedValue([
    { PK: 'USER#user-1', SK: 'CHAT#c1', title: 'T', model: 'x', systemPrompt: '', createdAt: '', updatedAt: '', activeLeafId: 'leaf-abc' },
    { PK: 'USER#user-1', SK: 'CHAT#c2', title: 'T2', model: 'x', systemPrompt: '', createdAt: '', updatedAt: '' },
  ])
  const res = result(await handler(makeEvent('GET', '/api/chats') as any))
  const body = JSON.parse(res.body ?? '{}')
  expect(body.chats[0].activeLeafId).toBe('leaf-abc')
  expect(body.chats[1].activeLeafId).toBeUndefined()  // not set on a fresh chat
})

test('POST /api/chats creates a chat', async () => {
  mockDynamo.putChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('POST', '/api/chats', { model: 'global.anthropic.claude-sonnet-4-6', systemPrompt: '' }) as any))
  expect(res.statusCode).toBe(201)
  const body = JSON.parse(res.body ?? '{}')
  expect(typeof body.chatId).toBe('string')
  expect(mockDynamo.putChat).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'New Chat', model: 'global.anthropic.claude-sonnet-4-6' }),
  )
})

test('PATCH /api/chats/{chatId} renames a chat', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.updateChatTitle.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('PATCH', '/api/chats/{chatId}', { title: 'New Title' }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(200)
  expect(mockDynamo.updateChatTitle).toHaveBeenCalledWith('user-1', 'c1', 'New Title')
})

test('DELETE /api/chats/{chatId} deletes chat', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.deleteChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('DELETE', '/api/chats/{chatId}', undefined, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(204)
})

test('DELETE /api/chats/{chatId} returns 404 if not owned', async () => {
  mockDynamo.getChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('DELETE', '/api/chats/{chatId}', undefined, { chatId: 'other' }) as any))
  expect(res.statusCode).toBe(404)
})

test('PATCH /api/chats/{chatId} returns 404 if not owned', async () => {
  mockDynamo.getChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('PATCH', '/api/chats/{chatId}', { title: 'X' }, { chatId: 'other' }) as any))
  expect(res.statusCode).toBe(404)
})

test('GET /api/chats does not include CORS header (handled by API GW/CloudFront)', async () => {
  mockDynamo.listChats.mockResolvedValue([])
  const res = result(await handler(makeEvent('GET', '/api/chats') as any))
  expect((res.headers as Record<string, string>)['Access-Control-Allow-Origin']).toBeUndefined()
})

// ── Input validation: POST /api/chats ─────────────────────────────────────────

test('POST /api/chats with non-JSON body returns 400', async () => {
  const event = {
    requestContext: { authorizer: { jwt: { claims: { sub: 'user-1' } } } },
    routeKey: 'POST /api/chats',
    pathParameters: {},
    body: 'not json',
  }
  const res = result(await handler(event as any))
  expect(res.statusCode).toBe(400)
  expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: 'Invalid JSON body' })
})

test('POST /api/chats with template-injection body returns 400', async () => {
  const event = {
    requestContext: { authorizer: { jwt: { claims: { sub: 'user-1' } } } },
    routeKey: 'POST /api/chats',
    pathParameters: {},
    body: '{{7*7}}',
  }
  const res = result(await handler(event as any))
  expect(res.statusCode).toBe(400)
})

// ── Input validation: PATCH /api/chats/{chatId} ───────────────────────────────

test('PATCH /api/chats/{chatId} with numeric title returns 400', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  const event = {
    requestContext: { authorizer: { jwt: { claims: { sub: 'user-1' } } } },
    routeKey: 'PATCH /api/chats/{chatId}',
    pathParameters: { chatId: 'c1' },
    // Use raw JSON string to avoid JS number precision loss while still testing the type guard
    body: '{"title":99999999999999999999999999}',
  }
  const res = result(await handler(event as any))
  expect(res.statusCode).toBe(400)
  expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: 'title must be a string' })
})

test('PATCH /api/chats/{chatId} with array title returns 400', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  const event = {
    requestContext: { authorizer: { jwt: { claims: { sub: 'user-1' } } } },
    routeKey: 'PATCH /api/chats/{chatId}',
    pathParameters: { chatId: 'c1' },
    body: JSON.stringify({ title: [1, 2, 3] }),
  }
  const res = result(await handler(event as any))
  expect(res.statusCode).toBe(400)
})

test('PATCH /api/chats/{chatId} with non-JSON body returns 400', async () => {
  const event = {
    requestContext: { authorizer: { jwt: { claims: { sub: 'user-1' } } } },
    routeKey: 'PATCH /api/chats/{chatId}',
    pathParameters: { chatId: 'c1' },
    body: 'not json at all',
  }
  const res = result(await handler(event as any))
  expect(res.statusCode).toBe(400)
})

// ── Model allowlist validation ────────────────────────────────────────────────

test('POST /api/chats with unknown model returns 400', async () => {
  mockDynamo.putChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('POST', '/api/chats', { model: 'us.meta.llama3-3-70b-instruct-v1:0' }) as any))
  expect(res.statusCode).toBe(400)
  expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: 'Invalid model' })
})

test('POST /api/chats with valid model succeeds', async () => {
  mockDynamo.putChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('POST', '/api/chats', { model: 'global.anthropic.claude-sonnet-4-6' }) as any))
  expect(res.statusCode).toBe(201)
})

test('PATCH /api/chats/{chatId} with unknown model returns 400', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  const res = result(await handler(makeEvent('PATCH', '/api/chats/{chatId}', { model: 'COMPLETELY_FAKE_MODEL' }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(400)
  expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: 'Invalid model' })
})

test('PATCH /api/chats/{chatId} with valid model succeeds', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.updateChatModel.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('PATCH', '/api/chats/{chatId}', { model: 'global.anthropic.claude-opus-4-8' }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(200)
})
