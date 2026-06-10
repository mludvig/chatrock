import { buildHandler } from '../../src/ws/sendMessage'
import * as dynamo from '../../src/lib/dynamo'
import * as bedrock from '../../src/lib/bedrock'

// Keep pure key-builder functions real; only mock the async DB operations
jest.mock('../../src/lib/dynamo', () => ({
  ...jest.requireActual('../../src/lib/dynamo'),
  getConnection: jest.fn(),
  getChat: jest.fn(),
  listMessages: jest.fn(),
  putMessage: jest.fn(),
  updateChatTitle: jest.fn(),
  updateChatActiveLeaf: jest.fn(),
}))
jest.mock('../../src/lib/bedrock')

const mockDynamo  = dynamo  as jest.Mocked<typeof dynamo>
const mockBedrock = bedrock as jest.Mocked<typeof bedrock>

const mockPost = jest.fn().mockResolvedValue(undefined)

const makeEvent = (body: object) => ({
  requestContext: {
    connectionId: 'conn-1',
    domainName: 'x.execute-api.ap-southeast-2.amazonaws.com',
    stage: 'prod',
  },
  body: JSON.stringify(body),
})

beforeEach(() => {
  jest.clearAllMocks()
  mockPost.mockResolvedValue(undefined)
})

// ── Slice 3: per-turn persistence with format-C records ───────────────────────

test('persists user prompt as a turn record and assistant response as per-turn records', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '', title: 'New Chat' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatTitle.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'delta' as const, text: 'Hello' }
    yield { type: 'delta' as const, text: ' world' }
    // usage emitted before turn (bedrock.ts order: usage → turn → stop)
    yield { type: 'usage' as const, usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'Hello world' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())
  mockBedrock.converseOnce.mockResolvedValue('Test Title')

  const handler = buildHandler(mockPost)
  await handler(makeEvent({ chatId: 'c1', content: 'Hi', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '' }))

  // User prompt + 1 assistant turn = 2 putMessage calls
  expect(mockDynamo.putMessage).toHaveBeenCalledTimes(2)

  // User prompt record: blocks=[{text}], role=user, has PK/SK from buildTurnKey
  const userCall = mockDynamo.putMessage.mock.calls.find(
    c => (c[0] as {role: string}).role === 'user',
  )![0] as Record<string, unknown>
  expect(userCall.role).toBe('user')
  expect(userCall.blocks).toEqual([{ text: 'Hi' }])
  expect((userCall.SK as string)).toMatch(/^MSG#.+#\d{4}#.+$/) // buildTurnKey format
  expect(userCall).not.toHaveProperty('content') // format-C uses blocks, not content

  // Assistant turn record: blocks verbatim from the turn chunk
  const assistantCall = mockDynamo.putMessage.mock.calls.find(
    c => (c[0] as {role: string}).role === 'assistant',
  )![0] as Record<string, unknown>
  expect(assistantCall.role).toBe('assistant')
  expect(assistantCall.blocks).toEqual([{ text: 'Hello world' }])
  expect(assistantCall.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  expect(assistantCall.turnIndex).toBe(0)
  expect(assistantCall).not.toHaveProperty('content') // format-C uses blocks
  expect(assistantCall).not.toHaveProperty('thinking') // no flat fields
  expect(assistantCall).not.toHaveProperty('toolCalls')
})

test('persists multiple turns from a tool-use round (user prompt + 2 assistant + 1 user-toolResult)', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '', title: 'Existing' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)

  async function* fakeStream() {
    // Round 0: thinking + toolUse
    yield { type: 'thinking_delta' as const, text: 'ponder' }
    yield { type: 'thinking_done' as const }
    yield { type: 'tool_call_start' as const, toolUseId: 't1', name: 'web_search' }
    yield { type: 'tool_call' as const, toolUseId: 't1', name: 'web_search', input: '{"query":"foo"}' }
    // usage emitted before its corresponding turn
    yield { type: 'usage' as const, usage: { inputTokens: 20, outputTokens: 8 } }
    yield {
      type: 'turn' as const,
      role: 'assistant' as const,
      content: [
        { reasoningContent: { reasoningText: { text: 'ponder', signature: 'SIG' } } },
        { toolUse: { toolUseId: 't1', name: 'web_search', input: { query: 'foo' } } },
      ],
      turnIndex: 0,
    }
    yield { type: 'tool_result' as const, toolUseId: 't1', name: 'web_search', content: 'results', isError: false }
    yield {
      type: 'turn' as const,
      role: 'user' as const,
      content: [{ toolResult: { toolUseId: 't1', content: [{ text: 'results' }], status: 'success' as const } }],
      turnIndex: 1,
    }
    // Round 1: final answer
    yield { type: 'delta' as const, text: 'done' }
    yield { type: 'usage' as const, usage: { inputTokens: 30, outputTokens: 5, cacheReadInputTokens: 15 } }
    yield {
      type: 'turn' as const,
      role: 'assistant' as const,
      content: [{ text: 'done' }],
      turnIndex: 2,
    }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '' }))

  // 4 putMessage calls: user prompt + assistant turn 0 + user-toolResult turn 1 + assistant turn 2
  expect(mockDynamo.putMessage).toHaveBeenCalledTimes(4)

  const calls = mockDynamo.putMessage.mock.calls.map(c => c[0] as Record<string, unknown>)
  const [userPrompt, asst0, userTool, asst2] = calls

  expect(userPrompt.role).toBe('user')
  expect(userPrompt.blocks).toEqual([{ text: 'Q' }])

  expect(asst0.role).toBe('assistant')
  expect(asst0.turnIndex).toBe(0)
  expect(asst0.usage).toMatchObject({ inputTokens: 20, outputTokens: 8 })
  // blocks contain reasoning (with signature) + toolUse verbatim
  const asst0Blocks = asst0.blocks as Array<Record<string, unknown>>
  expect(asst0Blocks[0]).toMatchObject({ reasoningContent: { reasoningText: { signature: 'SIG' } } })
  expect(asst0Blocks[1]).toMatchObject({ toolUse: { toolUseId: 't1' } })

  expect(userTool.role).toBe('user')
  expect(userTool.turnIndex).toBe(1)
  const toolBlocks = userTool.blocks as Array<Record<string, unknown>>
  expect(toolBlocks[0]).toMatchObject({ toolResult: { toolUseId: 't1' } })

  expect(asst2.role).toBe('assistant')
  expect(asst2.turnIndex).toBe(2)
  expect(asst2.usage).toMatchObject({ cacheReadInputTokens: 15 })
})

test('forwards a compact aggregated usage WS event', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '', title: 'Existing' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'delta' as const, text: 'hi' }
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'hi' }], turnIndex: 0 }
    yield { type: 'usage' as const, usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 50 } }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '' }))

  const payloads = mockPost.mock.calls.map(c => JSON.parse(c[0].Data) as Record<string, unknown>)
  const usageEvent = payloads.find(p => p.type === 'usage')
  expect(usageEvent).toBeDefined()
  expect(usageEvent!.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 50 })
})

test('replays history as verbatim blocks (not flat text)', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '', title: 'Existing' })

  // History with format-C records (blocks field + tree fields)
  mockDynamo.listMessages.mockResolvedValue([
    {
      PK: 'CHAT#c1', SK: 'MSG#t1#0000#u1', msgId: 'u1', parentId: null, role: 'user',
      blocks: [{ text: 'previous question' }], model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', createdAt: 't1',
      turnIndex: 0, responseId: 'r0',
    },
    {
      PK: 'CHAT#c1', SK: 'MSG#t1#0001#a1', msgId: 'a1', parentId: 'u1', role: 'assistant',
      blocks: [
        { reasoningContent: { reasoningText: { text: 'I thought', signature: 'MOCKED_SIG' } } },
        { text: 'previous answer' },
      ],
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', createdAt: 't1',
      turnIndex: 1, responseId: 'r0',
    },
  ])
  // getChat must return activeLeafId = last prior row's msgId so the user turn chains correctly
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '', title: 'Existing', activeLeafId: 'a1' })
  mockDynamo.putMessage.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'delta' as const, text: 'ok' }
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'ok' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'follow-up', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '' }))

  // converseStream was called with prior history + the new user turn
  const [, , passedMessages] = mockBedrock.converseStream.mock.calls[0]
  expect(passedMessages).toHaveLength(3)
  // First message content verbatim
  expect(passedMessages[0].content).toEqual([{ text: 'previous question' }])
  // Second message content verbatim (including reasoningContent with signature)
  expect(passedMessages[1].content).toEqual([
    { reasoningContent: { reasoningText: { text: 'I thought', signature: 'MOCKED_SIG' } } },
    { text: 'previous answer' },
  ])
  // Third message is the new user follow-up
  expect(passedMessages[2].content).toEqual([{ text: 'follow-up' }])
})

test('streams UI chunks and persists without persisting them on WS', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '', title: 'Existing' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'delta' as const, text: 'Hello' }
    yield { type: 'delta' as const, text: ' world' }
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'Hello world' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Hi', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '' }))

  // delta + done events posted over WS
  const dataPayloads = mockPost.mock.calls.map(c => JSON.parse(c[0].Data) as Record<string, unknown>)
  expect(dataPayloads.filter((d) => d.type === 'delta')).toHaveLength(2)
  expect(dataPayloads.find((d) => d.type === 'done')).toBeDefined()

  // 'turn' chunks must NOT be forwarded over WS (they're backend-only)
  expect(dataPayloads.find((d) => d.type === 'turn')).toBeUndefined()
})

test('sends titleUpdated event on first exchange', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '', title: 'New Chat' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatTitle.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())
  mockBedrock.converseOnce.mockResolvedValue('My Title')

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Hello', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '' }))

  const titleEvent = mockPost.mock.calls.map(c => JSON.parse(c[0].Data) as Record<string, unknown>).find((d) => d.type === 'titleUpdated')
  expect(titleEvent).toMatchObject({ type: 'titleUpdated', title: 'My Title', chatId: 'c1' })
  expect(mockDynamo.updateChatTitle).toHaveBeenCalledWith('user-1', 'c1', 'My Title')
})

test('does not re-title when chat already has a title', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '', title: 'Existing Title' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Hello', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '' }))

  expect(mockDynamo.updateChatTitle).not.toHaveBeenCalled()
  expect(mockBedrock.converseOnce).not.toHaveBeenCalled()
})

test('returns 410 when connection not found', async () => {
  mockDynamo.getConnection.mockResolvedValue(undefined)
  const res = await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Hi', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '' })) as Record<string, unknown>
  expect(res.statusCode).toBe(410)
})

test('sends error event when chat not found', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue(undefined)

  await buildHandler(mockPost)(makeEvent({ chatId: 'missing', content: 'Hi', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '' }))

  const errEvent = mockPost.mock.calls.map(c => JSON.parse(c[0].Data) as Record<string, unknown>).find((d) => d.type === 'error')
  expect(errEvent).toBeDefined()
  expect(mockDynamo.putMessage).not.toHaveBeenCalled()
})

// ── Model allowlist validation ────────────────────────────────────────────────

test('sends error event and does not invoke Bedrock for unknown model ID', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Hi', model: 'us.meta.llama3-3-70b-instruct-v1:0', systemPrompt: '' }))

  const errEvent = mockPost.mock.calls.map(c => JSON.parse(c[0].Data) as Record<string, unknown>).find(d => d.type === 'error')
  expect(errEvent).toBeDefined()
  expect(errEvent!.message).toBe('Invalid model')
  expect(mockBedrock.converseStream).not.toHaveBeenCalled()
  expect(mockDynamo.putMessage).not.toHaveBeenCalled()
})

test('sends error event for COMPLETELY_FAKE_EXPENSIVE_MODEL', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Hi', model: 'COMPLETELY_FAKE_EXPENSIVE_MODEL', systemPrompt: '' }))

  const errEvent = mockPost.mock.calls.map(c => JSON.parse(c[0].Data) as Record<string, unknown>).find(d => d.type === 'error')
  expect(errEvent).toMatchObject({ type: 'error', message: 'Invalid model' })
})

// ── Slice 2 (Inc 2): tree data model — msgId / parentId / activeLeafId ────────

const MODEL = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'

test('inc2: each persisted turn carries a top-level msgId and parentId', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing', activeLeafId: null })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'ok' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Hi', model: MODEL, systemPrompt: '' }))

  const calls = mockDynamo.putMessage.mock.calls.map(c => c[0] as Record<string, unknown>)
  for (const call of calls) {
    expect(typeof call.msgId).toBe('string')
    expect(call.msgId).toHaveLength(36) // uuid v4
    expect('parentId' in call).toBe(true)
  }
})

test('inc2: user prompt parentId = chat.activeLeafId (null for a fresh chat)', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  // Fresh chat: no activeLeafId
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'New Chat' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)
  mockDynamo.updateChatTitle.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'hi' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())
  mockBedrock.converseOnce.mockResolvedValue('Title')

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Hello', model: MODEL, systemPrompt: '' }))

  const userRecord = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(r => r.role === 'user')!
  expect(userRecord.parentId).toBeNull()
})

test('inc2: user prompt parentId = existing chat.activeLeafId', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing', activeLeafId: 'prev-leaf-id' })
  mockDynamo.listMessages.mockResolvedValue([
    { PK: 'CHAT#c1', SK: 'MSG#t#0000#prev-leaf-id', msgId: 'prev-leaf-id', parentId: null,
      role: 'assistant', blocks: [{ text: 'previous' }], model: MODEL, createdAt: 't', turnIndex: 0, responseId: 'r0' },
  ])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'new' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Follow-up', model: MODEL, systemPrompt: '' }))

  const userRecord = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(r => r.role === 'user')!
  expect(userRecord.parentId).toBe('prev-leaf-id')
})

test('inc2: response turns chain parentId from user turn through each assistant/tool turn', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  // Two turns: assistant + user-toolResult + assistant-final
  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ toolUse: { toolUseId: 't1', name: 'web_search', input: {} } }], turnIndex: 0 }
    yield { type: 'turn' as const, role: 'user' as const, content: [{ toolResult: { toolUseId: 't1', content: [{ text: 'res' }], status: 'success' as const } }], turnIndex: 1 }
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'done' }], turnIndex: 2 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

  const calls = mockDynamo.putMessage.mock.calls.map(c => c[0] as Record<string, unknown>)
  // calls: [userPrompt, asst0, userTool1, asst2]
  const [userPrompt, asst0, userTool1, asst2] = calls

  // Each turn's parentId = previous turn's msgId
  expect(asst0.parentId).toBe(userPrompt.msgId)
  expect(userTool1.parentId).toBe(asst0.msgId)
  expect(asst2.parentId).toBe(userTool1.msgId)
})

test('inc2: updateChatActiveLeaf called once after stream with the final turn msgId', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'final' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

  expect(mockDynamo.updateChatActiveLeaf).toHaveBeenCalledTimes(1)
  // The activeLeafId passed should be the final assistant turn's msgId
  const lastActiveLeaf = mockDynamo.updateChatActiveLeaf.mock.calls[0][2] as string
  const assistantRecord = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(r => r.role === 'assistant')!
  expect(lastActiveLeaf).toBe(assistantRecord.msgId)
})

// ── Slice 1 (Inc 3): re-run an answer ────────────────────────────────────────

const RERUN_PRIOR_ROWS = [
  { PK: 'CHAT#c1', SK: 'MSG#t#0000#u1', msgId: 'u1', parentId: null,
    role: 'user', blocks: [{ text: 'original question' }], model: MODEL, createdAt: 't', turnIndex: 0, responseId: 'r0' },
  { PK: 'CHAT#c1', SK: 'MSG#t#0001#a1', msgId: 'a1', parentId: 'u1',
    role: 'assistant', blocks: [{ text: 'original answer' }], model: MODEL, createdAt: 't', turnIndex: 1, responseId: 'r0' },
]

function rerunEvent(overrides: Record<string, unknown> = {}) {
  return makeEvent({ chatId: 'c1', model: MODEL, systemPrompt: '', parentId: 'u1', ...overrides })
}

function rerunBase() {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing', activeLeafId: 'a1' })
  mockDynamo.listMessages.mockResolvedValue(RERUN_PRIOR_ROWS)
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)
}

test('inc3: re-run does NOT persist a new user turn', async () => {
  rerunBase()
  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 're-answer' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(rerunEvent())

  const userPuts = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .filter(r => r.role === 'user')
  expect(userPuts).toHaveLength(0)
})

test('inc3: re-run new assistant turn parentId === given parentId', async () => {
  rerunBase()
  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 're-answer' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(rerunEvent())

  const assistantPut = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(r => r.role === 'assistant')!
  expect(assistantPut.parentId).toBe('u1')
})

test('inc3: re-run updateChatActiveLeaf called with new leaf msgId', async () => {
  rerunBase()
  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 're-answer' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(rerunEvent())

  expect(mockDynamo.updateChatActiveLeaf).toHaveBeenCalledTimes(1)
  const newLeaf = mockDynamo.updateChatActiveLeaf.mock.calls[0][2] as string
  const assistantPut = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(r => r.role === 'assistant')!
  expect(newLeaf).toBe(assistantPut.msgId)
})

test('inc3: re-run replay ends at the user turn — original answer NOT included', async () => {
  rerunBase()
  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 're-answer' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(rerunEvent())

  const [, , passedMessages] = mockBedrock.converseStream.mock.calls[0]
  // Only the user turn (root→u1), NOT the original answer (a1)
  expect(passedMessages).toHaveLength(1)
  expect(passedMessages[0].content).toEqual([{ text: 'original question' }])
  expect(passedMessages[0].role).toBe('user')
})

test('inc3: re-run does NOT call auto-title even when title is "New Chat"', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'New Chat', activeLeafId: 'a1' })
  mockDynamo.listMessages.mockResolvedValue(RERUN_PRIOR_ROWS)
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 're-answer' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(rerunEvent())

  expect(mockBedrock.converseOnce).not.toHaveBeenCalled()
  expect(mockDynamo.updateChatTitle).not.toHaveBeenCalled()
})

test('inc3: re-run with unknown parentId sends error and does not stream', async () => {
  rerunBase()

  await buildHandler(mockPost)(rerunEvent({ parentId: 'nonexistent-id' }))

  const errEvent = mockPost.mock.calls
    .map(c => JSON.parse(c[0].Data) as Record<string, unknown>)
    .find(d => d.type === 'error')
  expect(errEvent).toBeDefined()
  expect(mockBedrock.converseStream).not.toHaveBeenCalled()
  expect(mockDynamo.putMessage).not.toHaveBeenCalled()
})

test('inc2: Bedrock replay uses buildActivePath (linear chat: same as flat history)', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing', activeLeafId: 'asst-prev' })

  // Two prior rows — a linear chain (user → assistant)
  const priorRows = [
    { PK: 'CHAT#c1', SK: 'MSG#t#0000#user-prev', msgId: 'user-prev', parentId: null,
      role: 'user', blocks: [{ text: 'prior question' }], model: MODEL, createdAt: 't', turnIndex: 0, responseId: 'r0' },
    { PK: 'CHAT#c1', SK: 'MSG#t#0001#asst-prev', msgId: 'asst-prev', parentId: 'user-prev',
      role: 'assistant', blocks: [{ text: 'prior answer' }], model: MODEL, createdAt: 't', turnIndex: 1, responseId: 'r0' },
  ]
  mockDynamo.listMessages.mockResolvedValue(priorRows)
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'new' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Follow-up', model: MODEL, systemPrompt: '' }))

  // converseStream receives messages: [prior rows... + new user turn]
  // For a linear chat the active-path walk produces the same order as the flat array
  const [, , passedMessages] = mockBedrock.converseStream.mock.calls[0]
  // First two messages are the prior rows (verbatim blocks)
  expect(passedMessages[0].content).toEqual([{ text: 'prior question' }])
  expect(passedMessages[1].content).toEqual([{ text: 'prior answer' }])
  // Third message is the newly persisted user turn
  expect(passedMessages[2].content).toEqual([{ text: 'Follow-up' }])
})
