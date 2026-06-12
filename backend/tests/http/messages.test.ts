import { handler } from '../../src/http/messages'
import * as dynamo from '../../src/lib/dynamo'
import * as auth from '../../src/lib/auth'
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'

const result = (r: unknown) => r as APIGatewayProxyStructuredResultV2

jest.mock('../../src/lib/dynamo')
jest.mock('../../src/lib/auth')
jest.mock('../../src/lib/attachments', () => ({
  signCloudFrontUrl: jest.fn().mockResolvedValue('https://cdn.example.com/attachments/sub/chat/fid/shot.png?Sig=x'),
}))

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
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', activeLeafId: 'a2' })
  mockDynamo.listMessages.mockResolvedValue([
    // User prompt
    row({ SK: `MSG#${TS}#0000#u1`, msgId: 'u1', parentId: null, role: 'user', blocks: [{ text: 'question' }], responseId: 'user-r', turnIndex: 0 }),
    // Assistant turn 0: reasoning + toolUse
    row({
      SK: `MSG#${TS}#0001#a0`,
      msgId: 'a0', parentId: 'u1',
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
      SK: `MSG#${TS}#0002#tr1`,
      msgId: 'tr1', parentId: 'a0',
      role: 'user',
      blocks: [{ toolResult: { toolUseId: 'tu-1', content: [{ text: '{"results":[{"title":"T","url":"https://x.com","description":"D"}]}' }], status: 'success' } }],
      responseId,
      turnIndex: 1,
    }),
    // Assistant turn 2: final text
    row({
      SK: `MSG#${TS}#0003#a2`,
      msgId: 'a2', parentId: 'tr1',
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
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', activeLeafId: 'a2' })
  mockDynamo.listMessages.mockResolvedValue([
    row({
      SK: `MSG#${TS}#0000#a1`,
      msgId: 'a1', parentId: null,
      role: 'assistant',
      blocks: [{ text: 'a1' }],
      responseId: 'r1',
      turnIndex: 0,
      usage: { inputTokens: 10, outputTokens: 4 },
    }),
    row({
      SK: `MSG#${TS}#0001#a2`,
      msgId: 'a2', parentId: 'a1',
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

// ── Slice 3 (Inc 2): active-path filtering — only the active branch renders ───

test('inc2: linear chat (no siblings) renders the same bubbles as before', async () => {
  // Single branch: user → assistant, activeLeafId points to assistant turn
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', activeLeafId: 'asst-1' })
  mockDynamo.listMessages.mockResolvedValue([
    row({ SK: `MSG#${TS}#0000#user-1`, msgId: 'user-1', parentId: null, role: 'user', blocks: [{ text: 'q' }], responseId: 'r1', turnIndex: 0 }),
    row({ SK: `MSG#${TS}#0001#asst-1`, msgId: 'asst-1', parentId: 'user-1', role: 'assistant', blocks: [{ text: 'a' }], responseId: 'r1', turnIndex: 1 }),
  ])

  const res = result(await handler(makeEvent('c1')))
  const body = JSON.parse(res.body ?? '{}') as { bubbles: unknown[] }
  expect(body.bubbles).toHaveLength(2)  // user + assistant both rendered
})

test('inc2: only the active branch renders when siblings exist', async () => {
  // Tree: user-1 → asst-A (inactive)
  //             → asst-B (active, pointed to by activeLeafId)
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', activeLeafId: 'asst-B' })
  mockDynamo.listMessages.mockResolvedValue([
    row({ SK: `MSG#${TS}#0000#user-1`, msgId: 'user-1', parentId: null, role: 'user', blocks: [{ text: 'q' }], responseId: 'r0', turnIndex: 0 }),
    row({ SK: `MSG#${TS}#0001#asst-A`, msgId: 'asst-A', parentId: 'user-1', role: 'assistant', blocks: [{ text: 'answer A' }], responseId: 'r1', turnIndex: 0, usage: { inputTokens: 5, outputTokens: 2 } }),
    row({ SK: `MSG#${TS}#0002#asst-B`, msgId: 'asst-B', parentId: 'user-1', role: 'assistant', blocks: [{ text: 'answer B' }], responseId: 'r2', turnIndex: 0, usage: { inputTokens: 5, outputTokens: 3 } }),
  ])

  const res = result(await handler(makeEvent('c1')))
  const body = JSON.parse(res.body ?? '{}') as { bubbles: Array<Record<string, unknown>> }
  // Only user + asst-B should render; asst-A is on the inactive branch
  expect(body.bubbles).toHaveLength(2)
  const assistantBubble = body.bubbles.find(b => b.role === 'assistant')!
  const steps = assistantBubble.steps as Array<Record<string, unknown>>
  expect(steps[0]).toMatchObject({ kind: 'text', text: 'answer B' })
  // asst-A text must NOT appear
  const bodyStr = res.body ?? '{}'
  expect(bodyStr).not.toContain('answer A')
})

// ── Slice 2 (Inc 3): msgId + parentId on every bubble ────────────────────────

test('inc3: user bubble carries its row msgId and parentId', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', activeLeafId: 'asst-1' })
  mockDynamo.listMessages.mockResolvedValue([
    row({ SK: `MSG#${TS}#0000#u1`, msgId: 'u1', parentId: null, role: 'user', blocks: [{ text: 'q' }], responseId: 'r0', turnIndex: 0 }),
    row({ SK: `MSG#${TS}#0001#asst-1`, msgId: 'asst-1', parentId: 'u1', role: 'assistant', blocks: [{ text: 'a' }], responseId: 'r1', turnIndex: 1 }),
  ])

  const res = result(await handler(makeEvent('c1')))
  const body = JSON.parse(res.body ?? '{}') as { bubbles: Array<Record<string, unknown>> }
  const userBubble = body.bubbles.find(b => b.role === 'user')!
  expect(userBubble.msgId).toBe('u1')
  expect(userBubble.parentId).toBeNull()
})

test('inc3: assistant bubble carries first-turn msgId and parentId', async () => {
  // Multi-turn response: assistant turn 0 + user-toolResult + assistant turn 2 (same responseId)
  const responseId = 'resp-1'
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', activeLeafId: 'a2' })
  mockDynamo.listMessages.mockResolvedValue([
    row({ SK: `MSG#${TS}#0000#u1`, msgId: 'u1', parentId: null, role: 'user', blocks: [{ text: 'q' }], responseId: 'r0', turnIndex: 0 }),
    row({ SK: `MSG#${TS}#0001#a0`, msgId: 'a0', parentId: 'u1', role: 'assistant',
      blocks: [{ toolUse: { toolUseId: 'tu1', name: 'web_search', input: {} } }], responseId, turnIndex: 0 }),
    row({ SK: `MSG#${TS}#0002#tr1`, msgId: 'tr1', parentId: 'a0', role: 'user',
      blocks: [{ toolResult: { toolUseId: 'tu1', content: [{ text: 'res' }], status: 'success' } }], responseId, turnIndex: 1 }),
    row({ SK: `MSG#${TS}#0003#a2`, msgId: 'a2', parentId: 'tr1', role: 'assistant',
      blocks: [{ text: 'done' }], responseId, turnIndex: 2 }),
  ])

  const res = result(await handler(makeEvent('c1')))
  const body = JSON.parse(res.body ?? '{}') as { bubbles: Array<Record<string, unknown>> }
  const assistantBubble = body.bubbles.find(b => b.role === 'assistant')!
  // First turn of the group: a0
  expect(assistantBubble.msgId).toBe('a0')
  // parentId of first turn: u1 (the user turn that prompted this response)
  expect(assistantBubble.parentId).toBe('u1')
})

// ── Slice 2 (Inc 4): sibling metadata on bubbles ──────────────────────────────

test('inc4: single-child bubble has siblingCount 1 and siblingIndex 1', async () => {
  // Linear chat: no siblings anywhere
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', activeLeafId: 'asst-1' })
  mockDynamo.listMessages.mockResolvedValue([
    row({ SK: `MSG#${TS}#0000#u1`, msgId: 'u1', parentId: null, role: 'user', blocks: [{ text: 'q' }], responseId: 'r0', turnIndex: 0 }),
    row({ SK: `MSG#${TS}#0001#asst-1`, msgId: 'asst-1', parentId: 'u1', role: 'assistant', blocks: [{ text: 'a' }], responseId: 'r1', turnIndex: 0 }),
  ])

  const res = result(await handler(makeEvent('c1')))
  const body = JSON.parse(res.body ?? '{}') as { bubbles: Array<Record<string, unknown>> }
  for (const b of body.bubbles) {
    expect(b.siblingCount).toBe(1)
    expect(b.siblingIndex).toBe(1)
    expect(b.siblings).toHaveLength(1)
  }
})

test('inc4: three sibling assistant bubbles get correct siblingIndex and siblingCount', async () => {
  // Tree: user-1 → asst-A (1st), asst-B (2nd), asst-C (3rd, active)
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', activeLeafId: 'asst-C' })
  mockDynamo.listMessages.mockResolvedValue([
    row({ SK: `MSG#${TS}#0000#u1`, msgId: 'u1', parentId: null, role: 'user', blocks: [{ text: 'q' }], responseId: 'r0', turnIndex: 0 }),
    row({ SK: `MSG#${TS}#0001#asst-A`, msgId: 'asst-A', parentId: 'u1', role: 'assistant', blocks: [{ text: 'answer A' }], responseId: 'rA', turnIndex: 0 }),
    row({ SK: `MSG#${TS}#0002#asst-B`, msgId: 'asst-B', parentId: 'u1', role: 'assistant', blocks: [{ text: 'answer B' }], responseId: 'rB', turnIndex: 0 }),
    row({ SK: `MSG#${TS}#0003#asst-C`, msgId: 'asst-C', parentId: 'u1', role: 'assistant', blocks: [{ text: 'answer C' }], responseId: 'rC', turnIndex: 0 }),
  ])

  const res = result(await handler(makeEvent('c1')))
  const body = JSON.parse(res.body ?? '{}') as { bubbles: Array<Record<string, unknown>> }
  // Only 2 bubbles: user-1 + asst-C (active branch)
  expect(body.bubbles).toHaveLength(2)
  const assistantBubble = body.bubbles.find(b => b.role === 'assistant')!
  expect(assistantBubble.siblingCount).toBe(3)
  expect(assistantBubble.siblingIndex).toBe(3)  // asst-C is 3rd
  expect(assistantBubble.siblings).toEqual(['asst-A', 'asst-B', 'asst-C'])
  // User turn has no siblings (only one under null parent)
  const userBubble = body.bubbles.find(b => b.role === 'user')!
  expect(userBubble.siblingCount).toBe(1)
})

test('inc4: multi-turn tool response does not inflate sibling count', async () => {
  // One assistant bubble with tool-continuation turns; toolResult rows must NOT be counted as siblings
  const responseId = 'resp-1'
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', activeLeafId: 'a2' })
  mockDynamo.listMessages.mockResolvedValue([
    row({ SK: `MSG#${TS}#0000#u1`, msgId: 'u1', parentId: null, role: 'user', blocks: [{ text: 'q' }], responseId: 'r0', turnIndex: 0 }),
    row({ SK: `MSG#${TS}#0001#a0`, msgId: 'a0', parentId: 'u1', role: 'assistant',
      blocks: [{ toolUse: { toolUseId: 'tu1', name: 'web_search', input: {} } }], responseId, turnIndex: 0 }),
    row({ SK: `MSG#${TS}#0002#tr1`, msgId: 'tr1', parentId: 'a0', role: 'user',
      blocks: [{ toolResult: { toolUseId: 'tu1', content: [{ text: 'res' }], status: 'success' } }], responseId, turnIndex: 1 }),
    row({ SK: `MSG#${TS}#0003#a2`, msgId: 'a2', parentId: 'tr1', role: 'assistant',
      blocks: [{ text: 'done' }], responseId, turnIndex: 2 }),
  ])

  const res = result(await handler(makeEvent('c1')))
  const body = JSON.parse(res.body ?? '{}') as { bubbles: Array<Record<string, unknown>> }
  // Only 2 display bubbles: user + merged assistant (tool continuation folds in)
  expect(body.bubbles).toHaveLength(2)
  const assistantBubble = body.bubbles.find(b => b.role === 'assistant')!
  // The assistant bubble is the only child of user-1 (toolResult rows are folded, not siblings)
  expect(assistantBubble.siblingCount).toBe(1)
  expect(assistantBubble.siblingIndex).toBe(1)
})

// ── AttachmentStep rendering ──────────────────────────────────────────────────

describe('attachment steps in messages', () => {
  test('user turn with image s3Location block produces attachment step with signed URL', async () => {
    mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', activeLeafId: 'u1' })
    mockDynamo.listMessages.mockResolvedValue([
      row({
        msgId: 'u1',
        parentId: null,
        role: 'user',
        responseId: 'r1',
        blocks: [
          { text: 'Look at this' },
          { image: { format: 'png', source: { s3Location: { uri: 's3://bucket/attachments/sub/chat/fid/shot.png' } } } },
        ],
      }),
    ])

    const res = result(await handler(makeEvent('c1')))
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body ?? '{}')
    const bubble = body.bubbles[0]
    expect(bubble.role).toBe('user')

    const attachStep = bubble.steps.find((s: { kind: string }) => s.kind === 'attachment')
    expect(attachStep).toBeDefined()
    expect(attachStep.attachmentKind).toBe('image')
    expect(attachStep.url).toContain('cdn.example.com')
    expect(attachStep.url).not.toContain('s3://')
    expect(attachStep.filename).toBe('shot.png')
  })

  test('user turn image block with bytes (no s3Location) is silently skipped', async () => {
    mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', activeLeafId: 'u1' })
    mockDynamo.listMessages.mockResolvedValue([
      row({
        msgId: 'u1',
        parentId: null,
        role: 'user',
        responseId: 'r1',
        blocks: [
          { image: { format: 'png', source: { bytes: Buffer.from('PNG') } } },
        ],
      }),
    ])

    const res = result(await handler(makeEvent('c1')))
    const body = JSON.parse(res.body ?? '{}')
    const steps = body.bubbles[0].steps
    const attachStep = steps.find((s: { kind: string }) => s.kind === 'attachment')
    expect(attachStep).toBeUndefined()
  })

  test('user turn with document s3Location produces attachment step with document kind', async () => {
    mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', activeLeafId: 'u1' })
    mockDynamo.listMessages.mockResolvedValue([
      row({
        msgId: 'u1',
        parentId: null,
        role: 'user',
        responseId: 'r1',
        blocks: [
          { document: { format: 'pdf', name: 'Report', source: { s3Location: { uri: 's3://bucket/attachments/sub/chat/fid/report.pdf' } }, citations: { enabled: false } } },
        ],
      }),
    ])

    const res = result(await handler(makeEvent('c1')))
    const body = JSON.parse(res.body ?? '{}')
    const attachStep = body.bubbles[0].steps.find((s: { kind: string }) => s.kind === 'attachment')
    expect(attachStep).toBeDefined()
    expect(attachStep.attachmentKind).toBe('document')
    expect(attachStep.mode).toBe('standard')
    expect(attachStep.url).toContain('cdn.example.com')
  })

  test('image and document attachment steps include s3Key alongside signed url', async () => {
    mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', activeLeafId: 'u1' })
    mockDynamo.listMessages.mockResolvedValue([
      row({
        msgId: 'u1',
        parentId: null,
        role: 'user',
        responseId: 'r1',
        blocks: [
          { image: { format: 'png', source: { s3Location: { uri: 's3://bucket/attachments/sub/chat/fid/shot.png' } } } },
          { document: { format: 'pdf', name: 'Report', source: { s3Location: { uri: 's3://bucket/attachments/sub/chat/fid/report.pdf' } }, citations: { enabled: false } } },
        ],
      }),
    ])

    const res = result(await handler(makeEvent('c1')))
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body ?? '{}')
    const steps = body.bubbles[0].steps as Array<Record<string, unknown>>

    const imageStep = steps.find(s => s.kind === 'attachment' && s.attachmentKind === 'image')
    expect(imageStep).toBeDefined()
    expect(imageStep!.s3Key).toBe('attachments/sub/chat/fid/shot.png')
    expect(imageStep!.url).toContain('cdn.example.com')  // signed URL still present

    const docStep = steps.find(s => s.kind === 'attachment' && s.attachmentKind === 'document')
    expect(docStep).toBeDefined()
    expect(docStep!.s3Key).toBe('attachments/sub/chat/fid/report.pdf')
    expect(docStep!.url).toContain('cdn.example.com')  // signed URL still present
  })
})
