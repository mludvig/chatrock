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

// ── Slice 4: groupTurnsToBubbles ──────────────────────────────────────────────

const TS = '2025-01-01T00:00:00.000Z'

// Helper: build a format-C DDB row
function row(overrides: Record<string, unknown>) {
  return {
    PK: 'CHAT#c1',
    SK: `MSG#${TS}#0000#msg-x`,
    model: 'test-model',
    createdAt: TS,
    turnIndex: 0,
    responseId: 'r1',
    ...overrides,
  }
}

test('groups assistant reasoning+toolUse turn + toolResult user turn + text turn into ONE bubble with ordered steps', async () => {
  const responseId = 'resp-1'
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.listMessages.mockResolvedValue([
    // User prompt
    row({ SK: `MSG#${TS}#0000#u1`, role: 'user', blocks: [{ text: 'question' }], responseId: 'user-r', turnIndex: 0 }),
    // Assistant turn 0: reasoning + toolUse
    row({
      SK: `MSG#${TS}#0001#a0`,
      role: 'assistant',
      blocks: [
        { reasoningContent: { reasoningText: { text: 'I think', signature: 'SIG' } } },
        { toolUse: { toolUseId: 'tu-1', name: 'web_search', input: { query: 'foo' } } },
      ],
      responseId,
      turnIndex: 0,
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    // User turn 1: toolResult
    row({
      SK: `MSG#${TS}#0002#u1`,
      role: 'user',
      blocks: [{ toolResult: { toolUseId: 'tu-1', content: [{ text: '{"results":[{"title":"T","url":"https://x.com","description":"D"}]}' }], status: 'success' } }],
      responseId,
      turnIndex: 1,
    }),
    // Assistant turn 2: final text
    row({
      SK: `MSG#${TS}#0003#a2`,
      role: 'assistant',
      blocks: [{ text: 'final answer' }],
      responseId,
      turnIndex: 2,
      usage: { inputTokens: 20, outputTokens: 8, cacheReadInputTokens: 5 },
    }),
  ])

  const res = result(await handler(makeEvent('c1')))
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body ?? '{}') as { bubbles: unknown[]; conversationUsage: unknown }
  const bubbles = body.bubbles as Array<Record<string, unknown>>

  // Only 2 bubbles: user + assistant (the toolResult-user turn is folded in)
  expect(bubbles).toHaveLength(2)

  // Bubble 0: user prompt
  const userBubble = bubbles[0] as Record<string, unknown>
  expect(userBubble.role).toBe('user')
  const userSteps = userBubble.steps as Array<Record<string, unknown>>
  expect(userSteps).toHaveLength(1)
  expect(userSteps[0]).toMatchObject({ kind: 'text', text: 'question' })

  // Bubble 1: assistant — 4 ordered steps: thinking, tool (with result), text
  const assistantBubble = bubbles[1] as Record<string, unknown>
  expect(assistantBubble.role).toBe('assistant')
  const steps = assistantBubble.steps as Array<Record<string, unknown>>
  expect(steps).toHaveLength(3)
  expect(steps[0]).toMatchObject({ kind: 'thinking', text: 'I think' })
  expect(steps[1]).toMatchObject({ kind: 'tool', toolUseId: 'tu-1', name: 'web_search' })
  expect(steps[1].result).toContain('results')  // toolResult folded in
  expect(steps[2]).toMatchObject({ kind: 'text', text: 'final answer' })

  // Usage summed across assistant turns
  expect(assistantBubble.usage).toMatchObject({
    inputTokens: 30,      // 10 + 20
    outputTokens: 13,     // 5 + 8
    cacheReadInputTokens: 5,
  })
})

test('plain user turn becomes a bubble with a text step', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.listMessages.mockResolvedValue([
    row({ SK: `MSG#${TS}#0000#u1`, role: 'user', blocks: [{ text: 'hello' }], responseId: 'r-user', turnIndex: 0 }),
  ])

  const res = result(await handler(makeEvent('c1')))
  const body = JSON.parse(res.body ?? '{}') as { bubbles: unknown[] }
  const bubbles = body.bubbles as Array<Record<string, unknown>>
  expect(bubbles).toHaveLength(1)
  expect(bubbles[0].role).toBe('user')
  const steps = bubbles[0].steps as Array<Record<string, unknown>>
  expect(steps[0]).toMatchObject({ kind: 'text', text: 'hello' })
})

test('redacted thinking block becomes a thinking step with empty text', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.listMessages.mockResolvedValue([
    row({
      SK: `MSG#${TS}#0000#a1`,
      role: 'assistant',
      blocks: [
        { reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } },
        { text: 'answer' },
      ],
      responseId: 'r1',
      turnIndex: 0,
    }),
  ])

  const res = result(await handler(makeEvent('c1')))
  const body = JSON.parse(res.body ?? '{}') as { bubbles: unknown[] }
  const steps = (body.bubbles[0] as Record<string, unknown>).steps as Array<Record<string, unknown>>
  expect(steps[0]).toMatchObject({ kind: 'thinking', text: '' })
  expect(steps[1]).toMatchObject({ kind: 'text', text: 'answer' })
})

test('raw blocks, signatures, and redactedContent are NOT in the response', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.listMessages.mockResolvedValue([
    row({
      SK: `MSG#${TS}#0000#a1`,
      role: 'assistant',
      blocks: [
        { reasoningContent: { reasoningText: { text: 'secret', signature: 'TOP_SECRET_SIG' } } },
        { text: 'ok' },
      ],
      responseId: 'r1',
      turnIndex: 0,
    }),
  ])

  const res = result(await handler(makeEvent('c1')))
  const bodyStr = res.body ?? '{}'
  expect(bodyStr).not.toContain('TOP_SECRET_SIG')
  expect(bodyStr).not.toContain('blocks')
  expect(bodyStr).not.toContain('redactedContent')
  expect(bodyStr).not.toContain('signature')
})

test('conversationUsage sums all assistant turn usages', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.listMessages.mockResolvedValue([
    row({
      SK: `MSG#${TS}#0000#a1`,
      role: 'assistant',
      blocks: [{ text: 'a1' }],
      responseId: 'r1',
      turnIndex: 0,
      usage: { inputTokens: 10, outputTokens: 4 },
    }),
    row({
      SK: `MSG#${TS}#0001#a2`,
      role: 'assistant',
      blocks: [{ text: 'a2' }],
      responseId: 'r2',
      turnIndex: 0,
      usage: { inputTokens: 20, outputTokens: 6, cacheReadInputTokens: 8 },
    }),
  ])

  const res = result(await handler(makeEvent('c1')))
  const body = JSON.parse(res.body ?? '{}') as { conversationUsage: Record<string, number> }
  expect(body.conversationUsage).toMatchObject({
    inputTokens: 30,
    outputTokens: 10,
    cacheReadInputTokens: 8,
  })
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
