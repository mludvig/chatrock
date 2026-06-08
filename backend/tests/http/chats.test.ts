import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { handler } from '../../src/http/chats'
import * as dynamo from '../../src/lib/dynamo'

jest.mock('../../src/lib/dynamo')
const mockDynamo = dynamo as jest.Mocked<typeof dynamo>

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

test('POST /api/chats creates a chat', async () => {
  mockDynamo.putChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('POST', '/api/chats', { model: 'apac.anthropic.claude-sonnet-4-6', systemPrompt: '' }) as any))
  expect(res.statusCode).toBe(201)
  const body = JSON.parse(res.body ?? '{}')
  expect(typeof body.chatId).toBe('string')
  expect(mockDynamo.putChat).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'New Chat', model: 'apac.anthropic.claude-sonnet-4-6' }),
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
