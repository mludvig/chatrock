import { handler } from '../../src/http/messages'
import * as dynamo from '../../src/lib/dynamo'
import * as auth from '../../src/lib/auth'
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'

const result = (r: unknown) => r as APIGatewayProxyStructuredResultV2

jest.mock('../../src/lib/dynamo')
jest.mock('../../src/lib/auth')

const mockDynamo = dynamo as jest.Mocked<typeof dynamo>
const mockAuth   = auth   as jest.Mocked<typeof auth>

function makeEvent(chatId: string): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: { chatId },
    requestContext: {
      authorizer: { jwt: { claims: { sub: 'user-1' } } },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer
}

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.subFromClaims.mockReturnValue('user-1')
})

test('surfaces thinking and toolCalls when present on a message', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.listMessages.mockResolvedValue([
    {
      PK: 'CHAT#c1',
      SK: 'MSG#2025-01-01T00:00:00.000Z#msg-1',
      role: 'user',
      content: 'Hello',
      model: 'x',
      createdAt: '2025-01-01T00:00:00.000Z',
    },
    {
      PK: 'CHAT#c1',
      SK: 'MSG#2025-01-01T00:00:01.000Z#msg-2',
      role: 'assistant',
      content: 'Hi there',
      model: 'x',
      createdAt: '2025-01-01T00:00:01.000Z',
      thinking: 'I am thinking',
      toolCalls: [
        { toolUseId: 't1', name: 'web_search', input: '{"query":"foo"}', result: '{"results":[]}', isError: false },
      ],
    },
  ])

  const res = result(await handler(makeEvent('c1')))
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body ?? '{}') as { messages: unknown[] }
  const msgs = body.messages as Array<Record<string, unknown>>

  // User message — no thinking/toolCalls keys
  expect(msgs[0]).toMatchObject({ role: 'user', content: 'Hello' })
  expect(msgs[0]).not.toHaveProperty('thinking')
  expect(msgs[0]).not.toHaveProperty('toolCalls')

  // Assistant message — thinking + toolCalls surfaced
  expect(msgs[1]).toMatchObject({
    role: 'assistant',
    content: 'Hi there',
    thinking: 'I am thinking',
  })
  expect(msgs[1].toolCalls).toEqual([
    expect.objectContaining({ toolUseId: 't1', name: 'web_search', result: '{"results":[]}' }),
  ])
  // msgId extracted from SK tail
  expect(msgs[1].msgId).toBe('msg-2')
})

test('omits thinking and toolCalls keys for messages that do not have them', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.listMessages.mockResolvedValue([
    {
      PK: 'CHAT#c1',
      SK: 'MSG#2025-01-01T00:00:01.000Z#msg-old',
      role: 'assistant',
      content: 'Old answer',
      model: 'x',
      createdAt: '2025-01-01T00:00:01.000Z',
      // No thinking, no toolCalls — legacy message
    },
  ])

  const res = result(await handler(makeEvent('c1')))
  const body = JSON.parse(res.body ?? '{}') as { messages: unknown[] }
  const msg = (body.messages as Array<Record<string, unknown>>)[0]
  expect(msg).not.toHaveProperty('thinking')
  expect(msg).not.toHaveProperty('toolCalls')
  expect(msg.content).toBe('Old answer')
})

test('returns 404 when chat not found', async () => {
  mockDynamo.getChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('missing')))
  expect(res.statusCode).toBe(404)
})

test('returns 400 when chatId is missing', async () => {
  const res = result(await handler({
    pathParameters: {},
    requestContext: { authorizer: { jwt: { claims: { sub: 'user-1' } } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer))
  expect(res.statusCode).toBe(400)
})
