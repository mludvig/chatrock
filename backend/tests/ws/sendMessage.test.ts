import { buildHandler } from '../../src/ws/sendMessage'
import * as dynamo from '../../src/lib/dynamo'
import * as bedrock from '../../src/lib/bedrock'
import * as memoryLib from '../../src/lib/memory'
import * as enrichmentLib from '../../src/lib/enrichment'
import * as projectFilesMod from '../../src/lib/projectFiles'

jest.mock('../../src/lib/attachments', () => ({
  attachmentBlock: jest.fn().mockReturnValue({ image: { format: 'png', source: { s3Location: { uri: 's3://bucket/key.png' } } } }),
  hydrateBlocks: jest.fn().mockImplementation(async (blocks: unknown[]) => blocks),
}))
import * as attachmentsMod from '../../src/lib/attachments'
const mockAttachments = attachmentsMod as jest.Mocked<typeof attachmentsMod>

// Keep pure key-builder functions real; only mock the async DB operations
jest.mock('../../src/lib/dynamo', () => ({
  ...jest.requireActual('../../src/lib/dynamo'),
  getConnection: jest.fn(),
  getChat: jest.fn(),
  listMessages: jest.fn(),
  putMessage: jest.fn(),
  updateChatTitle: jest.fn(),
  updateChatActiveLeaf: jest.fn(),
  isStreamCancelled: jest.fn().mockResolvedValue(false),
  clearStreamCancel: jest.fn().mockResolvedValue(undefined),
  getUserPrefs: jest.fn().mockResolvedValue({}),
  listUserMemories: jest.fn().mockResolvedValue([]),
  putUserMemory: jest.fn().mockResolvedValue(undefined),
  deleteUserMemory: jest.fn().mockResolvedValue(undefined),
  getProject: jest.fn().mockResolvedValue(undefined),
  listProjectMemories: jest.fn().mockResolvedValue([]),
  putProjectMemory: jest.fn().mockResolvedValue(undefined),
  updateChatSummary: jest.fn().mockResolvedValue(undefined),
  listProjectFiles: jest.fn().mockResolvedValue([]),
  listChats: jest.fn().mockResolvedValue([]),
}))

jest.mock('../../src/lib/projectFiles', () => ({
  fetchS3Text: jest.fn().mockResolvedValue(''),
  fetchS3Bytes: jest.fn().mockResolvedValue(new Uint8Array()),
  summarizeFile: jest.fn().mockResolvedValue({ microLabel: 'File', summary: 'A file.' }),
}))
jest.mock('../../src/lib/bedrock')
jest.mock('../../src/lib/memory', () => ({
  reconcile: jest.fn().mockReturnValue([]),
}))
jest.mock('../../src/lib/enrichment', () => ({
  enrichTurn: jest.fn().mockResolvedValue({ userFacts: [] }),
}))

const mockDynamo  = dynamo  as jest.Mocked<typeof dynamo>
const mockBedrock = bedrock as jest.Mocked<typeof bedrock>
const mockMemory  = memoryLib as jest.Mocked<typeof memoryLib>
const mockEnrichment = enrichmentLib as jest.Mocked<typeof enrichmentLib>
const mockProjectFiles = projectFilesMod as jest.Mocked<typeof projectFilesMod>

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
  mockEnrichment.enrichTurn.mockResolvedValue({ userFacts: [] })
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
  // enrichTurn returns a title when needTitle=true (first normal send with title='New Chat')
  mockEnrichment.enrichTurn.mockResolvedValue({ userFacts: [], title: 'My Title' })

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
  // enrichTurn returns no title when needTitle=false (existing title)
  mockEnrichment.enrichTurn.mockResolvedValue({ userFacts: [] })

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Hello', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', systemPrompt: '' }))

  expect(mockDynamo.updateChatTitle).not.toHaveBeenCalled()
  // enrichTurn is called (for user facts + no title), but NOT converseOnce directly
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
  // enrichTurn is called (memory extraction) but must NOT return a title for re-runs
  mockEnrichment.enrichTurn.mockResolvedValue({ userFacts: [] })

  await buildHandler(mockPost)(rerunEvent())

  // enrichTurn is called with needTitle:false for re-runs
  expect(mockEnrichment.enrichTurn).toHaveBeenCalledWith(expect.objectContaining({ needTitle: false }))
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

// ── Increment 5: Edit & recreate a question ─────────────────────────────────

// Fixtures: same two-row tree as re-run tests.
// u1 is the root user turn (parentId: null), a1 is its assistant answer.
// An edit of u1 sends { parentId: null, content: 'edited question' } — parentId
// key is PRESENT (distinguishes from normal send which omits it).

function editEvent(overrides: Record<string, unknown> = {}) {
  // parentId: null = editing the root user turn u1
  return makeEvent({ chatId: 'c1', model: MODEL, systemPrompt: '', parentId: null, content: 'edited question', ...overrides })
}

test('inc5: edit persists a new user turn with edited content and correct parentId', async () => {
  rerunBase()
  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'new answer' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(editEvent())

  const userPuts = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .filter(r => r.role === 'user')
  expect(userPuts).toHaveLength(1)
  expect(userPuts[0].parentId).toBeNull()
  expect(userPuts[0].blocks).toEqual([{ text: 'edited question' }])
})

test('inc5: edit new user turn has a different msgId from the original', async () => {
  rerunBase()
  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'new answer' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(editEvent())

  const userPut = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(r => r.role === 'user')!
  expect(userPut.msgId).not.toBe('u1')
})

test('inc5: edit assistant turn parentId === new user turn msgId', async () => {
  rerunBase()
  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'new answer' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(editEvent())

  const userPut = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(r => r.role === 'user')!
  const assistantPut = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(r => r.role === 'assistant')!
  expect(assistantPut.parentId).toBe(userPut.msgId)
})

test('inc5: edit updateChatActiveLeaf called once with the new assistant leaf', async () => {
  rerunBase()
  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'new answer' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(editEvent())

  expect(mockDynamo.updateChatActiveLeaf).toHaveBeenCalledTimes(1)
  const newLeaf = mockDynamo.updateChatActiveLeaf.mock.calls[0][2] as string
  const assistantPut = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(r => r.role === 'assistant')!
  expect(newLeaf).toBe(assistantPut.msgId)
})

test('inc5: edit replay is root→new-user-turn (edited content is last message)', async () => {
  rerunBase()
  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'new answer' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(editEvent())

  const [, , passedMessages] = mockBedrock.converseStream.mock.calls[0]
  // Root edit: only the new user turn in history (no prior ancestor)
  expect(passedMessages).toHaveLength(1)
  expect(passedMessages[0].role).toBe('user')
  expect(passedMessages[0].content).toEqual([{ text: 'edited question' }])
})

test('inc5: edit does NOT call auto-title when title is "New Chat"', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'New Chat', activeLeafId: 'a1' })
  mockDynamo.listMessages.mockResolvedValue(RERUN_PRIOR_ROWS)
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'new answer' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())
  // enrichTurn is called (memory extraction) but must NOT return a title for edits
  mockEnrichment.enrichTurn.mockResolvedValue({ userFacts: [] })

  await buildHandler(mockPost)(editEvent())

  // enrichTurn is called with needTitle:false for edits
  expect(mockEnrichment.enrichTurn).toHaveBeenCalledWith(expect.objectContaining({ needTitle: false }))
  expect(mockDynamo.updateChatTitle).not.toHaveBeenCalled()
})

test('inc5: edit with unknown non-null parentId sends error frame and does not stream', async () => {
  rerunBase()

  await buildHandler(mockPost)(editEvent({ parentId: 'nonexistent-id', content: 'edited question' }))

  const errEvent = mockPost.mock.calls
    .map(c => JSON.parse(c[0].Data) as Record<string, unknown>)
    .find(d => d.type === 'error')
  expect(errEvent).toBeDefined()
  expect(mockBedrock.converseStream).not.toHaveBeenCalled()
  expect(mockDynamo.putMessage).not.toHaveBeenCalled()
})

test('inc5: edit with non-null parentId creates new user turn as sibling under that parent', async () => {
  // Tree: u1 (root) → a1 → u2 → a2
  const rows = [
    { PK: 'CHAT#c1', SK: 'MSG#t#0000#u1', msgId: 'u1', parentId: null,
      role: 'user', blocks: [{ text: 'q1' }], model: MODEL, createdAt: 't', turnIndex: 0, responseId: 'r0' },
    { PK: 'CHAT#c1', SK: 'MSG#t#0001#a1', msgId: 'a1', parentId: 'u1',
      role: 'assistant', blocks: [{ text: 'a1' }], model: MODEL, createdAt: 't', turnIndex: 1, responseId: 'r0' },
    { PK: 'CHAT#c1', SK: 'MSG#t#0002#u2', msgId: 'u2', parentId: 'a1',
      role: 'user', blocks: [{ text: 'q2' }], model: MODEL, createdAt: 't', turnIndex: 0, responseId: 'r1' },
    { PK: 'CHAT#c1', SK: 'MSG#t#0003#a2', msgId: 'a2', parentId: 'u2',
      role: 'assistant', blocks: [{ text: 'a2' }], model: MODEL, createdAt: 't', turnIndex: 1, responseId: 'r1' },
  ]
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing', activeLeafId: 'a2' })
  mockDynamo.listMessages.mockResolvedValue(rows)
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'edited a1' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  // Edit u2: its parentId is 'a1', so the new user sibling also has parentId 'a1'
  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', model: MODEL, systemPrompt: '', parentId: 'a1', content: 'mid-convo edit' }))

  const userPut = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(r => r.role === 'user')!
  expect(userPut.parentId).toBe('a1')
  expect(userPut.blocks).toEqual([{ text: 'mid-convo edit' }])
  // New user turn is a different node from u2
  expect(userPut.msgId).not.toBe('u2')
})

// ── Increment D (D3): stream cancel behaviour ─────────────────────────────────

test('d3: cancel between turns — persisted turns survive, cancelled event emitted', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)
  mockDynamo.isStreamCancelled.mockResolvedValue(false)
  mockDynamo.clearStreamCancel.mockResolvedValue(undefined)

  // Fake stream: yields one complete turn, then throws AbortError (simulating the
  // abort signal being fired by the poll timer between turns).
  const converseStreamFn = jest.fn((_model: unknown, _sys: unknown, _msgs: unknown, _settings: unknown, signal?: AbortSignal) =>
    (async function* () {
      yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'first answer' }], turnIndex: 0 }
      // Simulate the abort signal firing (as if the poll timer called abort())
      if (signal) {
        const ctrl = (signal as unknown as { _controller?: AbortController })._controller
        if (ctrl) ctrl.abort()
      }
      throw Object.assign(new Error('AbortError'), { name: 'AbortError' })
    })()
  )
  mockBedrock.converseStream.mockImplementation(converseStreamFn as typeof mockBedrock.converseStream)

  // Override converseStream to receive the AbortController signal and abort it
  // A simpler approach: the fake stream throws AbortError directly to simulate cancellation.
  const converseStreamFn2 = jest.fn((_m: unknown, _s: unknown, _msgs: unknown, _settings: unknown, _signal?: AbortSignal) =>
    (async function* () {
      yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'first answer' }], turnIndex: 0 }
      // Throw AbortError to simulate the signal firing
      const err = new Error('Request aborted')
      err.name = 'AbortError'
      throw err
    })()
  )
  mockBedrock.converseStream.mockImplementation(converseStreamFn2 as typeof mockBedrock.converseStream)
  // Make isStreamCancelled return true so the catch block recognises it as a cancel
  mockDynamo.isStreamCancelled.mockResolvedValue(true)

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

  // User turn + first assistant turn both persisted
  const putCalls = mockDynamo.putMessage.mock.calls.map(c => c[0] as Record<string, unknown>)
  expect(putCalls.some(r => r.role === 'user')).toBe(true)
  expect(putCalls.some(r => r.role === 'assistant')).toBe(true)

  // 'cancelled' event emitted, not 'done'
  const events = mockPost.mock.calls.map(c => JSON.parse(c[0].Data) as Record<string, unknown>)
  expect(events.find(e => e.type === 'cancelled')).toBeDefined()
  expect(events.find(e => e.type === 'done')).toBeUndefined()

  // activeLeafId set to the last persisted turn
  expect(mockDynamo.updateChatActiveLeaf).toHaveBeenCalledTimes(1)
  const cancelledLeaf = mockDynamo.updateChatActiveLeaf.mock.calls[0][2] as string
  const assistantPut = putCalls.find(r => r.role === 'assistant')!
  expect(cancelledLeaf).toBe(assistantPut.msgId)
})

test('d3: cancel mid-turn — partial text flushed as assistant turn, cancelled event emitted', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)
  mockDynamo.isStreamCancelled.mockResolvedValue(true)
  mockDynamo.clearStreamCancel.mockResolvedValue(undefined)

  // Fake stream: emits partial deltas, then throws AbortError mid-turn (no 'turn' chunk)
  const converseStreamFn = jest.fn((_m: unknown, _s: unknown, _msgs: unknown, _settings: unknown) =>
    (async function* () {
      yield { type: 'delta' as const, text: 'partial ' }
      yield { type: 'delta' as const, text: 'answer' }
      const err = new Error('Request aborted')
      err.name = 'AbortError'
      throw err
    })()
  )
  mockBedrock.converseStream.mockImplementation(converseStreamFn as typeof mockBedrock.converseStream)

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

  const putCalls = mockDynamo.putMessage.mock.calls.map(c => c[0] as Record<string, unknown>)

  // Partial text should have been flushed as an assistant turn
  const partialPut = putCalls.find(r => r.role === 'assistant')
  expect(partialPut).toBeDefined()
  expect(partialPut!.blocks).toEqual([{ text: 'partial answer' }])

  // 'cancelled' WS event emitted
  const events = mockPost.mock.calls.map(c => JSON.parse(c[0].Data) as Record<string, unknown>)
  expect(events.find(e => e.type === 'cancelled')).toBeDefined()
  expect(events.find(e => e.type === 'done')).toBeUndefined()

  // activeLeafId updated to the partial turn
  expect(mockDynamo.updateChatActiveLeaf).toHaveBeenCalledTimes(1)
  const cancelLeaf = mockDynamo.updateChatActiveLeaf.mock.calls[0][2] as string
  expect(cancelLeaf).toBe(partialPut!.msgId)
})

// ── Increment F: per-turn metadata + web-search toggle ───────────────────────

test('f1: assistant turn row stores thinkingEffort and webSearch from modelSettings', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'hi' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({
    chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '',
    modelSettings: { thinkingEffort: 'high', webSearch: true },
  }))

  const assistantPut = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(r => r.role === 'assistant')!

  expect(assistantPut.thinkingEffort).toBe('high')
  expect(assistantPut.webSearch).toBe(true)
})

test('f2: webSearch:false passes empty tools — converseStream called with webSearch:false setting', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'ok' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({
    chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '',
    modelSettings: { webSearch: false },
  }))

  // The modelSettings passed to converseStream must include webSearch:false
  const [, , , passedSettings] = mockBedrock.converseStream.mock.calls[0]
  expect((passedSettings as Record<string, unknown>).webSearch).toBe(false)
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

describe('attachments in WS payload', () => {
  test('user turn includes attachment blocks when attachments provided', async () => {
    mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
    mockDynamo.getChat.mockResolvedValue({
      PK: 'USER#user-1', SK: 'CHAT#c1',
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      systemPrompt: '', title: 'T',
    })
    mockDynamo.listMessages.mockResolvedValue([])
    mockDynamo.putMessage.mockResolvedValue(undefined)
    mockDynamo.updateChatTitle?.mockResolvedValue(undefined)

    const fakeStream = async function* () {
      yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'OK' }], turnIndex: 0 }
      yield { type: 'stop' as const, stopReason: 'end_turn' }
    }
    mockBedrock.converseStream.mockReturnValue(fakeStream())
    mockBedrock.converseOnce?.mockResolvedValue('Title')

    const handler = buildHandler(mockPost)
    await handler(makeEvent({
      chatId: 'c1',
      content: 'Look at this',
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      systemPrompt: '',
      attachments: [{ s3Key: 'attachments/u/c/f/shot.png', contentType: 'image/png', filename: 'shot.png' }],
    }))

    const userCall = mockDynamo.putMessage.mock.calls.find(
      (c: unknown[]) => (c[0] as { role: string }).role === 'user',
    )?.[0] as Record<string, unknown> | undefined

    expect(userCall).toBeDefined()
    const blocks = userCall!.blocks as unknown[]
    expect(blocks.length).toBeGreaterThan(1)
    expect(mockAttachments.attachmentBlock).toHaveBeenCalledWith(
      expect.objectContaining({ s3Key: 'attachments/u/c/f/shot.png' }),
    )
  })

  test('attachment-only send (no content) has no text block — only attachment blocks', async () => {
    mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
    mockDynamo.getChat.mockResolvedValue({
      PK: 'USER#user-1', SK: 'CHAT#c1',
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      systemPrompt: '', title: 'T',
    })
    mockDynamo.listMessages.mockResolvedValue([])
    mockDynamo.putMessage.mockResolvedValue(undefined)
    mockDynamo.updateChatTitle?.mockResolvedValue(undefined)

    const fakeStream = async function* () {
      yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'I see it' }], turnIndex: 0 }
      yield { type: 'stop' as const, stopReason: 'end_turn' }
    }
    mockBedrock.converseStream.mockReturnValue(fakeStream())
    mockBedrock.converseOnce?.mockResolvedValue('Title')

    const handler = buildHandler(mockPost)
    await handler(makeEvent({
      chatId: 'c1',
      // No content — attachment-only
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      systemPrompt: '',
      attachments: [{ s3Key: 'attachments/u/c/f/shot.png', contentType: 'image/png', filename: 'shot.png' }],
    }))

    const userCall = mockDynamo.putMessage.mock.calls.find(
      (c: unknown[]) => (c[0] as { role: string }).role === 'user',
    )?.[0] as Record<string, unknown> | undefined

    expect(userCall).toBeDefined()
    const blocks = userCall!.blocks as { text?: string; image?: unknown }[]
    // No blank text block — attachment-only payload should start with the image block
    expect(blocks.some(b => b.text !== undefined && b.text.trim() === '')).toBe(false)
    expect(blocks.some(b => b.image !== undefined)).toBe(true)
  })
})

// ── Slice 1b: user preferences wired into sendMessage ────────────────────────

function prefsBase() {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)
}

test('prefs1: uses assembleSystemPrompt with user prefs — persona appears in system prompt', async () => {
  prefsBase()
  mockDynamo.getUserPrefs.mockResolvedValue({ persona: 'Be brief' })

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'ok' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

  const [, passedSystemPrompt] = mockBedrock.converseStream.mock.calls[0]
  expect(typeof passedSystemPrompt).toBe('string')
  expect(passedSystemPrompt as string).toContain('Be brief')
})

test('prefs2: client modelSettings override user preference defaults', async () => {
  prefsBase()
  // User default: webSearch off
  mockDynamo.getUserPrefs.mockResolvedValue({ webSearch: false })

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'ok' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  // Client explicitly turns web search ON — must win
  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '', modelSettings: { webSearch: true } }))

  const [, , , passedSettings] = mockBedrock.converseStream.mock.calls[0]
  expect((passedSettings as Record<string, unknown>).webSearch).toBe(true)
})

test('prefs3: getUserPrefs failure propagates as a fatal error — converseStream not called', async () => {
  prefsBase()
  mockDynamo.getUserPrefs.mockRejectedValue(new Error('DynamoDB unavailable'))

  // The handler propagates the DynamoDB error — converseStream must NOT be called
  await expect(
    buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))
  ).rejects.toThrow('DynamoDB unavailable')

  expect(mockBedrock.converseStream).not.toHaveBeenCalled()
})

// ── Slice 2b: memory extraction and prompt injection ─────────────────────────

function memoryBase() {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)
  mockDynamo.getUserPrefs.mockResolvedValue({})
  mockDynamo.listUserMemories.mockResolvedValue([])
  mockDynamo.putUserMemory.mockResolvedValue(undefined)
  mockEnrichment.enrichTurn.mockResolvedValue({ userFacts: [] })
  mockMemory.reconcile.mockReturnValue([])
}

test('mem1: memory extraction runs after assistant message persisted — putUserMemory called and memoryUpdated frame emitted', async () => {
  memoryBase()
  // enrichTurn returns a user fact; reconcile produces an ADD op
  mockEnrichment.enrichTurn.mockResolvedValue({ userFacts: [{ category: 'identity', text: 'User is from NZ' }] })
  mockMemory.reconcile.mockReturnValue([{ op: 'ADD', text: 'User is from NZ', category: 'identity' }])

  async function* fakeStream() {
    yield { type: 'delta' as const, text: 'Hello from NZ' }
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'Hello from NZ' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Hi, I am from NZ', model: MODEL, systemPrompt: '' }))

  // putUserMemory must have been called for the ADD op
  expect(mockDynamo.putUserMemory).toHaveBeenCalledTimes(1)
  const memArg = mockDynamo.putUserMemory.mock.calls[0][0] as Record<string, unknown>
  expect(memArg.text).toBe('User is from NZ')
  expect(memArg.category).toBe('identity')
  expect(typeof memArg.memId).toBe('string')

  // memoryUpdated WS frame emitted with count=1
  const events = mockPost.mock.calls.map(c => JSON.parse(c[0].Data) as Record<string, unknown>)
  const memoryEvent = events.find(e => e.type === 'memoryUpdated')
  expect(memoryEvent).toBeDefined()
  expect(memoryEvent!.count).toBe(1)
})

test('mem2: memory extraction failure is swallowed — chat turn completes normally', async () => {
  memoryBase()
  // enrichTurn throws; handler should swallow the error and emit a warning
  mockEnrichment.enrichTurn.mockRejectedValue(new Error('Bedrock timeout'))

  async function* fakeStream() {
    yield { type: 'delta' as const, text: 'ok' }
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'ok' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  const res = await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' })) as Record<string, unknown>

  // Handler returns 200 (turn completed normally)
  expect(res.statusCode).toBe(200)

  // 'done' event was still sent (stream completed successfully)
  const events = mockPost.mock.calls.map(c => JSON.parse(c[0].Data) as Record<string, unknown>)
  expect(events.find(e => e.type === 'done')).toBeDefined()

  // No memoryUpdated frame (extraction failed), but a warning frame is emitted
  expect(events.find(e => e.type === 'memoryUpdated')).toBeUndefined()
  expect(events.find(e => e.type === 'warning')).toBeDefined()
})

test('mem3: user memories are injected into assembled prompt', async () => {
  memoryBase()
  mockDynamo.listUserMemories.mockResolvedValue([
    {
      PK: 'USER#user-1',
      SK: 'MEM#USER#mem-1',
      memId: 'mem-1',
      text: 'User is a software engineer',
      category: 'identity',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ])

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'ok' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

  // converseStream must have been called with a system prompt containing the memory text
  const [, passedSystemPrompt] = mockBedrock.converseStream.mock.calls[0]
  expect(typeof passedSystemPrompt).toBe('string')
  expect(passedSystemPrompt as string).toContain('User is a software engineer')
})

// ── memoryEnabled toggle ──────────────────────────────────────────────────────

test('mem4: memoryEnabled:false — listUserMemories NOT called and memory text absent from system prompt', async () => {
  memoryBase()
  mockDynamo.listUserMemories.mockResolvedValue([
    {
      PK: 'USER#user-1',
      SK: 'MEM#USER#mem-1',
      memId: 'mem-1',
      text: 'User is a software engineer',
      category: 'identity',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ])

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'ok' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({
    chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '',
    modelSettings: { memoryEnabled: false },
  }))

  // listUserMemories must NOT be called (memory fetch skipped entirely)
  expect(mockDynamo.listUserMemories).not.toHaveBeenCalled()

  // The system prompt passed to converseStream must NOT contain the memory text
  const [, passedSystemPrompt] = mockBedrock.converseStream.mock.calls[0]
  expect(passedSystemPrompt as string).not.toContain('User is a software engineer')
})

test('mem5: memoryEnabled:false — enrichTurn NOT called (extraction skipped)', async () => {
  memoryBase()

  async function* fakeStream() {
    yield { type: 'delta' as const, text: 'Hello' }
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'Hello' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({
    chatId: 'c1', content: 'Hi', model: MODEL, systemPrompt: '',
    modelSettings: { memoryEnabled: false },
  }))

  // enrichTurn must NOT be called when memory is disabled
  expect(mockEnrichment.enrichTurn).not.toHaveBeenCalled()

  // No memoryUpdated WS frame emitted
  const events = mockPost.mock.calls.map(c => JSON.parse(c[0].Data) as Record<string, unknown>)
  expect(events.find(e => e.type === 'memoryUpdated')).toBeUndefined()
})

// ── Part 2: error-flush — partial work preserved on Bedrock error ─────────────
//
// Before the fix, a non-abort Bedrock error discarded partialText and never
// updated activeLeafId. After the fix, the error branch must:
//   1. Flush any partial text as an `incomplete:true` assistant turn in DDB.
//   2. Update activeLeafId to the last persisted turn (even if just the user turn).
//   3. Send an `error` frame that includes `leafId` (the last msgId on the active path).
//
// The fix mirrors the existing cancel-path flush logic.

function errorBase() {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)
  // NOT a cancel — error path
  mockDynamo.isStreamCancelled.mockResolvedValue(false)
}

test('err1: Bedrock error mid-turn — partial text flushed as incomplete assistant turn', async () => {
  errorBase()

  mockBedrock.converseStream.mockImplementation(() => (async function* () {
    yield { type: 'delta' as const, text: 'partial ' }
    yield { type: 'delta' as const, text: 'answer' }
    throw new Error('ValidationException: toolConfig required')
  })())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

  const putCalls = mockDynamo.putMessage.mock.calls.map(c => c[0] as Record<string, unknown>)
  const partialPut = putCalls.find(r => r.role === 'assistant')

  expect(partialPut).toBeDefined()
  expect(partialPut!.blocks).toEqual([{ text: 'partial answer' }])
  expect(partialPut!.incomplete).toBe(true)
})

test('err2: Bedrock error mid-turn — activeLeafId updated to the flushed partial turn', async () => {
  errorBase()

  mockBedrock.converseStream.mockImplementation(() => (async function* () {
    yield { type: 'delta' as const, text: 'some text' }
    throw new Error('ServiceUnavailableException')
  })())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

  expect(mockDynamo.updateChatActiveLeaf).toHaveBeenCalledTimes(1)
  const putCalls = mockDynamo.putMessage.mock.calls.map(c => c[0] as Record<string, unknown>)
  const partialPut = putCalls.find(r => r.role === 'assistant')!
  const leafArg = mockDynamo.updateChatActiveLeaf.mock.calls[0][2] as string
  expect(leafArg).toBe(partialPut.msgId)
})

test('err3: Bedrock error mid-turn — error frame carries leafId', async () => {
  errorBase()

  mockBedrock.converseStream.mockImplementation(() => (async function* () {
    yield { type: 'delta' as const, text: 'hello' }
    throw new Error('InternalServerError')
  })())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

  const events = mockPost.mock.calls.map(c => JSON.parse(c[0].Data) as Record<string, unknown>)
  const errEvent = events.find(e => e.type === 'error')!
  expect(errEvent).toBeDefined()
  expect(typeof errEvent.leafId).toBe('string')
  expect(errEvent.leafId).toHaveLength(36) // uuid

  // leafId should match the partial assistant turn that was persisted
  const putCalls = mockDynamo.putMessage.mock.calls.map(c => c[0] as Record<string, unknown>)
  const partialPut = putCalls.find(r => r.role === 'assistant')!
  expect(errEvent.leafId).toBe(partialPut.msgId)
})

test('err4: Bedrock error before any output — activeLeafId updated to user turn, no assistant turn written', async () => {
  errorBase()

  mockBedrock.converseStream.mockImplementation(() => (async function* () {
    throw new Error('ThrottlingException')
    // eslint-disable-next-line no-unreachable
    yield { type: 'delta' as const, text: 'never' }
  })())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

  const putCalls = mockDynamo.putMessage.mock.calls.map(c => c[0] as Record<string, unknown>)
  // Only the user turn — no partial assistant turn
  expect(putCalls.filter(r => r.role === 'assistant')).toHaveLength(0)

  // activeLeafId still updated (to the user turn)
  expect(mockDynamo.updateChatActiveLeaf).toHaveBeenCalledTimes(1)
  const userPut = putCalls.find(r => r.role === 'user')!
  const leafArg = mockDynamo.updateChatActiveLeaf.mock.calls[0][2] as string
  expect(leafArg).toBe(userPut.msgId)
})

test('err5: Bedrock error after complete turns — survived turns intact, last turn is new active leaf', async () => {
  errorBase()

  mockBedrock.converseStream.mockImplementation(() => (async function* () {
    // First tool-use turn fully persisted before error
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ toolUse: { toolUseId: 't1', name: 'web_search', input: {} } }], turnIndex: 0 }
    yield { type: 'turn' as const, role: 'user' as const, content: [{ toolResult: { toolUseId: 't1', content: [{ text: 'res' }], status: 'success' as const } }], turnIndex: 1 }
    // Then partial text starts streaming and the error fires
    yield { type: 'delta' as const, text: 'partial result' }
    throw new Error('ValidationException: toolConfig required')
  })())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

  const putCalls = mockDynamo.putMessage.mock.calls.map(c => c[0] as Record<string, unknown>)
  // user prompt + asst turn 0 + user tool-result turn 1 + flushed partial asst
  expect(putCalls).toHaveLength(4)
  const partialPut = putCalls[3]
  expect(partialPut.role).toBe('assistant')
  expect(partialPut.blocks).toEqual([{ text: 'partial result' }])
  expect(partialPut.incomplete).toBe(true)

  // activeLeaf points to the flushed partial
  const leafArg = mockDynamo.updateChatActiveLeaf.mock.calls[0][2] as string
  expect(leafArg).toBe(partialPut.msgId)
})

// ── Part 3: Continue mechanic ─────────────────────────────────────────────────
//
// Continue resumes generation from an errored/incomplete leaf.
// Payload: { chatId, parentId: <bubbleMsgId>, continue: true, model, ... }
// (no content field)
//
// Behaviour differs from re-run:
//  - Replay is INCLUSIVE of the leaf (extends from it, not before it).
//  - New assistant turns chain as CHILD of the leaf (not sibling under a parent).
//  - New turns reuse the failed response's responseId so groupTurnsToBubbles fuses them.
//  - No auto-title.

const CONTINUE_PRIOR_ROWS = [
  { PK: 'CHAT#c1', SK: 'MSG#t#0000#u1', msgId: 'u1', parentId: null,
    role: 'user', blocks: [{ text: 'original question' }], model: MODEL, createdAt: 't', turnIndex: 0, responseId: 'r0' },
  { PK: 'CHAT#c1', SK: 'MSG#t#0001#a1', msgId: 'a1', parentId: 'u1',
    role: 'assistant', blocks: [{ text: 'partial answer' }], model: MODEL, createdAt: 't', turnIndex: 1, responseId: 'r0', incomplete: true },
]

function continueEvent(overrides: Record<string, unknown> = {}) {
  return makeEvent({ chatId: 'c1', model: MODEL, systemPrompt: '', parentId: 'a1', continue: true, ...overrides })
}

function continueBase() {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing', activeLeafId: 'a1' })
  mockDynamo.listMessages.mockResolvedValue(CONTINUE_PRIOR_ROWS)
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)
}

test('cont1: continue does NOT persist a new user turn', async () => {
  continueBase()
  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'continued answer' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(continueEvent())

  const userPuts = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .filter(r => r.role === 'user')
  expect(userPuts).toHaveLength(0)
})

test('cont2: continue new assistant turn parentId === the leaf msgId (child, not sibling)', async () => {
  continueBase()
  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'continued' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(continueEvent())

  const asstPut = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(r => r.role === 'assistant')!
  // parentId must be the leaf (a1), not the user turn (u1)
  expect(asstPut.parentId).toBe('a1')
})

test('cont3: continue new turns reuse the failed responseId so bubbles fuse', async () => {
  continueBase()
  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'continued' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(continueEvent())

  const asstPut = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(r => r.role === 'assistant')!
  // responseId must match the failed response's responseId (r0) not a new uuid
  expect(asstPut.responseId).toBe('r0')
})

test('cont4: continue replay is INCLUSIVE of the leaf (assistant-terminated history = prefill)', async () => {
  continueBase()
  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'continued' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(continueEvent())

  const [, , passedMessages] = mockBedrock.converseStream.mock.calls[0]
  // Should be: [user-u1, assistant-a1] (leaf included, not just root→parent)
  expect(passedMessages).toHaveLength(2)
  expect(passedMessages[0].role).toBe('user')
  expect(passedMessages[0].content).toEqual([{ text: 'original question' }])
  expect(passedMessages[1].role).toBe('assistant')
  expect(passedMessages[1].content).toEqual([{ text: 'partial answer' }])
})

test('cont5: continue updateChatActiveLeaf called with the new continuation turn msgId', async () => {
  continueBase()
  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'continued' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(continueEvent())

  expect(mockDynamo.updateChatActiveLeaf).toHaveBeenCalledTimes(1)
  const newLeaf = mockDynamo.updateChatActiveLeaf.mock.calls[0][2] as string
  const asstPut = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(r => r.role === 'assistant')!
  expect(newLeaf).toBe(asstPut.msgId)
})

test('cont6: continue with unknown parentId sends error and does not stream', async () => {
  continueBase()

  await buildHandler(mockPost)(continueEvent({ parentId: 'nonexistent-id' }))

  const errEvent = mockPost.mock.calls
    .map(c => JSON.parse(c[0].Data) as Record<string, unknown>)
    .find(d => d.type === 'error')
  expect(errEvent).toBeDefined()
  expect(mockBedrock.converseStream).not.toHaveBeenCalled()
  expect(mockDynamo.putMessage).not.toHaveBeenCalled()
})

test('cont7: continue does NOT call auto-title even when title is "New Chat"', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'New Chat', activeLeafId: 'a1' })
  mockDynamo.listMessages.mockResolvedValue(CONTINUE_PRIOR_ROWS)
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'continued' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())
  // enrichTurn is called (memory extraction) but must NOT return a title for continues
  mockEnrichment.enrichTurn.mockResolvedValue({ userFacts: [] })

  await buildHandler(mockPost)(continueEvent())

  // enrichTurn is called with needTitle:false for continues
  expect(mockEnrichment.enrichTurn).toHaveBeenCalledWith(expect.objectContaining({ needTitle: false }))
  expect(mockDynamo.updateChatTitle).not.toHaveBeenCalled()
})

test('cont8: continue from toolResult-user leaf — replay ends at user turn (clean continuation)', async () => {
  // Tree: u1 → a1 (toolUse) → toolResult-u2 (incomplete continuation point)
  const rows = [
    { PK: 'CHAT#c1', SK: 'MSG#t#0000#u1', msgId: 'u1', parentId: null,
      role: 'user', blocks: [{ text: 'question' }], model: MODEL, createdAt: 't', turnIndex: 0, responseId: 'r0' },
    { PK: 'CHAT#c1', SK: 'MSG#t#0001#a1', msgId: 'a1', parentId: 'u1',
      role: 'assistant', blocks: [{ toolUse: { toolUseId: 't1', name: 'web_search', input: {} } }], model: MODEL, createdAt: 't', turnIndex: 1, responseId: 'r0' },
    { PK: 'CHAT#c1', SK: 'MSG#t#0002#tr1', msgId: 'tr1', parentId: 'a1',
      role: 'user', blocks: [{ toolResult: { toolUseId: 't1', content: [{ text: 'result' }], status: 'success' as const } }], model: MODEL, createdAt: 't', turnIndex: 2, responseId: 'r0' },
  ]
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing', activeLeafId: 'tr1' })
  mockDynamo.listMessages.mockResolvedValue(rows)
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'final answer' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', model: MODEL, systemPrompt: '', parentId: 'tr1', continue: true }))

  const [, , passedMessages] = mockBedrock.converseStream.mock.calls[0]
  // Replay: u1 (user), a1 (assistant), tr1 (user toolResult) — ends in user = clean
  expect(passedMessages).toHaveLength(3)
  expect(passedMessages[2].role).toBe('user')

  // New turn chains from tr1 (the leaf)
  const asstPut = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(r => r.role === 'assistant')!
  expect(asstPut.parentId).toBe('tr1')
  expect(asstPut.responseId).toBe('r0')
})

test('cont9: continue uses resolveResponseLeaf — bubble msgId (first turn) resolves to deepest turn', async () => {
  // Tree: u1 → a1 (first asst turn, bubble msgId) → tr1 (toolResult) → a2 (incomplete leaf, deepest)
  const rows = [
    { PK: 'CHAT#c1', SK: 'MSG#t#0000#u1', msgId: 'u1', parentId: null,
      role: 'user', blocks: [{ text: 'q' }], model: MODEL, createdAt: 't', turnIndex: 0, responseId: 'r0' },
    { PK: 'CHAT#c1', SK: 'MSG#t#0001#a1', msgId: 'a1', parentId: 'u1',
      role: 'assistant', blocks: [{ toolUse: { toolUseId: 't1', name: 'web_search', input: {} } }], model: MODEL, createdAt: 't', turnIndex: 1, responseId: 'r0' },
    { PK: 'CHAT#c1', SK: 'MSG#t#0002#tr1', msgId: 'tr1', parentId: 'a1',
      role: 'user', blocks: [{ toolResult: { toolUseId: 't1', content: [{ text: 'res' }], status: 'success' as const } }], model: MODEL, createdAt: 't', turnIndex: 2, responseId: 'r0' },
    { PK: 'CHAT#c1', SK: 'MSG#t#0003#a2', msgId: 'a2', parentId: 'tr1',
      role: 'assistant', blocks: [{ text: 'partial' }], model: MODEL, createdAt: 't', turnIndex: 3, responseId: 'r0', incomplete: true },
  ]
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing', activeLeafId: 'a2' })
  mockDynamo.listMessages.mockResolvedValue(rows)
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'final' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  // Client passes bubble's msgId (a1 = first turn of response), NOT the deepest turn
  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', model: MODEL, systemPrompt: '', parentId: 'a1', continue: true }))

  // Backend should resolve to a2 (deepest turn in r0), so replay includes a2 and
  // new turn chains from a2
  const [, , passedMessages] = mockBedrock.converseStream.mock.calls[0]
  // Full path: u1, a1, tr1, a2 (4 messages)
  expect(passedMessages).toHaveLength(4)

  const asstPut = mockDynamo.putMessage.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(r => r.role === 'assistant')!
  // chains from a2 (the resolved leaf), not a1 (what was passed)
  expect(asstPut.parentId).toBe('a2')
  expect(asstPut.responseId).toBe('r0')
})

// ── Task D: LLM call structured logging ──────────────────────────────────────

test('D1a: llm_call chat log emitted after stop chunk with stopReason and token fields', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'usage' as const, usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3 } }
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'hi' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))
  const logCalls = [...logSpy.mock.calls]
  logSpy.mockRestore()

  const chatLog = logCalls
    .map(args => { try { return JSON.parse(args[0] as string) as Record<string, unknown> } catch { return null } })
    .find(obj => obj?.event === 'llm_call' && obj?.purpose === 'chat')

  expect(chatLog).toBeDefined()
  expect(chatLog!.stopReason).toBe('end_turn')
  expect(chatLog!.model).toBe(MODEL)
  expect(chatLog!.chatId).toBe('c1')
  expect(chatLog!.inputTokens).toBe(10)
  expect(chatLog!.outputTokens).toBe(5)
  expect(chatLog!.cacheReadInputTokens).toBe(3)
})

test('D1b: llm_call enrich_turn log emitted after enrichTurn call', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'New Chat' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)
  mockDynamo.updateChatTitle.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'ok' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())
  // enrichTurn returns a title (first normal send with title='New Chat')
  mockEnrichment.enrichTurn.mockResolvedValue({ userFacts: [], title: 'Generated Title' })

  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))
  const logCalls = [...logSpy.mock.calls]
  logSpy.mockRestore()

  const enrichLog = logCalls
    .map(args => { try { return JSON.parse(args[0] as string) as Record<string, unknown> } catch { return null } })
    .find(obj => obj?.event === 'llm_call' && obj?.purpose === 'enrich_turn')

  expect(enrichLog).toBeDefined()
  expect(enrichLog!.chatId).toBe('c1')
  // Verify the title was also applied
  expect(mockDynamo.updateChatTitle).toHaveBeenCalledWith('user-1', 'c1', 'Generated Title')
})

test('D1c: llm_call enrich_turn log emitted and user facts persisted via reconcile', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  // Use 'Existing Chat' title so needTitle=false
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing Chat' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)
  mockDynamo.listUserMemories.mockResolvedValue([])
  mockDynamo.putUserMemory.mockResolvedValue(undefined)

  // enrichTurn returns 2 user facts; reconcile ADD-deduplicates them
  mockEnrichment.enrichTurn.mockResolvedValue({
    userFacts: [
      { category: 'identity', text: 'User is from NZ' },
      { category: 'preference', text: 'User likes Python' },
    ],
  })
  mockMemory.reconcile.mockReturnValue([
    { op: 'ADD', text: 'User is from NZ', category: 'identity' },
    { op: 'ADD', text: 'User likes Python', category: 'preference' },
  ])

  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'hi' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))
  const logCalls = [...logSpy.mock.calls]
  logSpy.mockRestore()

  const enrichLog = logCalls
    .map(args => { try { return JSON.parse(args[0] as string) as Record<string, unknown> } catch { return null } })
    .find(obj => obj?.event === 'llm_call' && obj?.purpose === 'enrich_turn')

  expect(enrichLog).toBeDefined()
  expect(enrichLog!.chatId).toBe('c1')
  // Both facts were persisted via putUserMemory
  expect(mockDynamo.putUserMemory).toHaveBeenCalledTimes(2)
})

test('memoryChanged chunk from converseStream → postFn called with memoryUpdated event', async () => {
  memoryBase()

  async function* fakeStream() {
    yield { type: 'delta' as const, text: 'ok' }
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'ok' }], turnIndex: 0 }
    yield { type: 'memoryChanged' as const }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

  const events = mockPost.mock.calls.map(c => JSON.parse(c[0].Data) as Record<string, unknown>)
  const memEvent = events.find(e => e.type === 'memoryUpdated')
  expect(memEvent).toBeDefined()
  expect(memEvent!.count).toBe(1)
})

test('memoryChanged during stream suppresses passive-extractor memoryUpdated to prevent double toast', async () => {
  // Both the tool loop (memoryChanged) AND passive extraction would fire.
  // Only one memoryUpdated frame should reach the client.
  memoryBase()
  // enrichTurn (passive extractor) will find a new fact via reconcile ADD
  mockEnrichment.enrichTurn.mockResolvedValue({ userFacts: [{ category: 'identity', text: 'User is from NZ' }] })
  mockMemory.reconcile.mockReturnValue([{ op: 'ADD', text: 'User is from NZ', category: 'identity' }])

  async function* fakeStream() {
    yield { type: 'delta' as const, text: 'Noted' }
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'Noted' }], turnIndex: 0 }
    yield { type: 'memoryChanged' as const }  // tool already fired
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'remember I am from NZ', model: MODEL, systemPrompt: '' }))

  const events = mockPost.mock.calls.map(c => JSON.parse(c[0].Data) as Record<string, unknown>)
  const memEvents = events.filter(e => e.type === 'memoryUpdated')
  // Exactly one memoryUpdated frame — the one from memoryChanged (count:1)
  // The passive-extractor postFn call must be suppressed
  expect(memEvents).toHaveLength(1)
  expect(memEvents[0].count).toBe(1)
})

// ── Project chat enrichment ───────────────────────────────────────────────────

describe('project chat enrichment', () => {
  function projectBase() {
    mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
    mockDynamo.getChat.mockResolvedValue({
      PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing',
      projectId: 'proj-1',
    })
    mockDynamo.listMessages.mockResolvedValue([])
    mockDynamo.putMessage.mockResolvedValue(undefined)
    mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)
    mockDynamo.getUserPrefs.mockResolvedValue({})
    mockDynamo.listUserMemories.mockResolvedValue([])
    mockDynamo.putUserMemory.mockResolvedValue(undefined)
    mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJ#proj-1', projectId: 'proj-1', name: 'My Project', instructions: 'Always use TypeScript' })
    mockDynamo.listProjectMemories.mockResolvedValue([])
    mockDynamo.putProjectMemory.mockResolvedValue(undefined)
    mockDynamo.updateChatSummary.mockResolvedValue(undefined)
    mockDynamo.listProjectFiles.mockResolvedValue([])
    mockDynamo.listChats.mockResolvedValue([])
    mockMemory.reconcile.mockReturnValue([])
    mockEnrichment.enrichTurn.mockResolvedValue({
      userFacts: [{ category: 'identity', text: 'Alice' }],
      projectFacts: [{ category: 'decision', text: 'Deploy via deploy.sh' }],
      summary: 'Deployment chat',
    })
  }

  function simpleStream() {
    async function* gen() {
      yield { type: 'delta' as const, text: 'ok' }
      yield { type: 'turn' as const, role: 'assistant' as const, content: [{ text: 'ok' }], turnIndex: 0 }
      yield { type: 'stop' as const, stopReason: 'end_turn' }
    }
    mockBedrock.converseStream.mockReturnValue(gen())
  }

  test('P1: project chat — enrichTurn called with isProject:true', async () => {
    projectBase()
    simpleStream()

    await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

    expect(mockEnrichment.enrichTurn).toHaveBeenCalledWith(
      expect.objectContaining({ isProject: true }),
    )
  })

  test('P2: project chat — putProjectMemory called for new project fact ADD', async () => {
    projectBase()
    simpleStream()
    // reconcile returns ADD for projectFacts (and nothing for userFacts to isolate the assertion)
    // 'other' is shared between UserMemory and ProjectMemory category types
    mockMemory.reconcile
      .mockReturnValueOnce([])  // first call: user facts → no adds
      .mockReturnValueOnce([{ op: 'ADD', text: 'Deploy via deploy.sh', category: 'other' }])  // second call: project facts → ADD

    await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

    expect(mockDynamo.putProjectMemory).toHaveBeenCalledTimes(1)
    const arg = mockDynamo.putProjectMemory.mock.calls[0][0] as Record<string, unknown>
    expect(arg.text).toBe('Deploy via deploy.sh')
    expect(arg.category).toBe('other')
  })

  test('P3: project chat — updateChatSummary called with summary from enrichResult', async () => {
    projectBase()
    simpleStream()

    await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

    expect(mockDynamo.updateChatSummary).toHaveBeenCalledTimes(1)
    expect(mockDynamo.updateChatSummary).toHaveBeenCalledWith('user-1', 'c1', 'Deployment chat')
  })

  test('P4: project chat — project instructions included in assembled system prompt', async () => {
    projectBase()
    simpleStream()

    await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

    // converseStream receives the assembled system prompt; it should contain project instructions
    const [, passedSystemPrompt] = mockBedrock.converseStream.mock.calls[0]
    expect(typeof passedSystemPrompt).toBe('string')
    expect(passedSystemPrompt as string).toContain('Always use TypeScript')
  })

  test('P5: non-project chat — enrichTurn called with isProject:false, no putProjectMemory or updateChatSummary', async () => {
    // Chat with no projectId
    mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
    mockDynamo.getChat.mockResolvedValue({
      PK: 'USER#user-1', SK: 'CHAT#c1', model: MODEL, systemPrompt: '', title: 'Existing',
      // no projectId field
    })
    mockDynamo.listMessages.mockResolvedValue([])
    mockDynamo.putMessage.mockResolvedValue(undefined)
    mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)
    mockDynamo.getUserPrefs.mockResolvedValue({})
    mockDynamo.listUserMemories.mockResolvedValue([])
    mockMemory.reconcile.mockReturnValue([])
    mockEnrichment.enrichTurn.mockResolvedValue({ userFacts: [] })
    simpleStream()

    await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

    expect(mockEnrichment.enrichTurn).toHaveBeenCalledWith(
      expect.objectContaining({ isProject: false }),
    )
    expect(mockDynamo.putProjectMemory).not.toHaveBeenCalled()
    expect(mockDynamo.updateChatSummary).not.toHaveBeenCalled()
  })

  test('P6: project chat — manifest files included in system prompt', async () => {
    projectBase()
    mockDynamo.listProjectFiles.mockResolvedValue([
      { fileId: 'f1', filename: 'spec.md', contentType: 'text/markdown', status: 'ready', inclusion: 'auto', microLabel: 'Project spec', s3Key: 'k/spec.md' } as Record<string, unknown>,
    ])
    simpleStream()

    await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

    const [, sysPrompt] = mockBedrock.converseStream.mock.calls[0]
    expect(sysPrompt as string).toContain('f1')
    expect(sysPrompt as string).toContain('spec.md')
    expect(sysPrompt as string).toContain('Project spec')
    expect(sysPrompt as string).toContain('NAVIGATIONAL ONLY')
  })

  test('P7: never-inclusion file excluded from manifest', async () => {
    projectBase()
    mockDynamo.listProjectFiles.mockResolvedValue([
      { fileId: 'f1', filename: 'secret.txt', contentType: 'text/plain', status: 'ready', inclusion: 'never', microLabel: 'Secret', s3Key: 'k/secret.txt' } as Record<string, unknown>,
    ])
    simpleStream()

    await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

    const [, sysPrompt] = mockBedrock.converseStream.mock.calls[0]
    expect(sysPrompt as string).not.toContain('secret.txt')
  })

  test('P8: always-inclusion text file → fetchS3Text called, content in system prompt', async () => {
    projectBase()
    mockDynamo.listProjectFiles.mockResolvedValue([
      { fileId: 'f2', filename: 'rules.txt', contentType: 'text/plain', status: 'ready', inclusion: 'always', s3Key: 'k/rules.txt' } as Record<string, unknown>,
    ])
    mockProjectFiles.fetchS3Text.mockResolvedValue('Always follow these rules.')
    simpleStream()

    await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

    expect(mockProjectFiles.fetchS3Text).toHaveBeenCalledWith('k/rules.txt')
    const [, sysPrompt] = mockBedrock.converseStream.mock.calls[0]
    expect(sysPrompt as string).toContain('Always follow these rules.')
    expect(sysPrompt as string).toContain('Always-included project files')
  })

  test('P9: sibling chat appears in manifest; current chat excluded', async () => {
    projectBase()
    mockDynamo.listChats.mockResolvedValue([
      { SK: 'CHAT#c1', projectId: 'proj-1', title: 'Current Chat' } as Record<string, unknown>,
      { SK: 'CHAT#c2', projectId: 'proj-1', title: 'Sibling Chat', summary: 'About auth.' } as Record<string, unknown>,
      { SK: 'CHAT#c3', projectId: 'other-proj', title: 'Other Project Chat' } as Record<string, unknown>,
    ])
    simpleStream()

    await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

    const [, sysPrompt] = mockBedrock.converseStream.mock.calls[0]
    expect(sysPrompt as string).toContain('c2')
    expect(sysPrompt as string).toContain('Sibling Chat')
    expect(sysPrompt as string).not.toContain('c1') // current chat excluded
    expect(sysPrompt as string).not.toContain('Other Project Chat') // wrong project
  })

  test('P10: toolCtx includes chatId for project chats', async () => {
    projectBase()
    simpleStream()

    await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

    // converseStream receives toolCtx as 5th arg
    const toolCtxArg = mockBedrock.converseStream.mock.calls[0][4]
    expect(toolCtxArg).toMatchObject({ sub: 'user-1', projectId: 'proj-1', chatId: 'c1' })
  })

  test('P11: 55 ready files → manifest capped at 50, manifest_truncated logged', async () => {
    projectBase()
    const files = Array.from({ length: 55 }, (_, i) => ({
      fileId: `f${i}`, filename: `file${i}.txt`, contentType: 'text/plain',
      status: 'ready', inclusion: 'auto', s3Key: `k/file${i}.txt`,
    } as Record<string, unknown>))
    mockDynamo.listProjectFiles.mockResolvedValue(files)
    simpleStream()

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

      // Find the call to assembleSystemPrompt by inspecting the system prompt passed to converseStream
      const [, sysPrompt] = mockBedrock.converseStream.mock.calls[0]
      // Count occurrences of 'file' in manifest section — should be limited to 50
      const manifestMatches = (sysPrompt as string).match(/file\d+\.txt/g) ?? []
      expect(manifestMatches.length).toBeLessThanOrEqual(50)

      const truncatedCall = consoleSpy.mock.calls.find(args =>
        typeof args[0] === 'string' && args[0].includes('manifest_truncated') && args[0].includes('"kind":"files"')
      )
      expect(truncatedCall).toBeDefined()
      const parsed = JSON.parse(truncatedCall![0] as string)
      expect(parsed).toMatchObject({
        event: 'manifest_truncated',
        kind: 'files',
        total: 55,
        kept: 50,
        projectId: expect.any(String),
        chatId: expect.any(String),
      })
    } finally {
      consoleSpy.mockRestore()
    }
  })

  test('P12: 35 sibling chats → manifest capped at 30', async () => {
    projectBase()
    const chats = Array.from({ length: 36 }, (_, i) => ({
      SK: `CHAT#chat${i}`,
      projectId: 'proj-1',
      title: `Chat ${i}`,
    } as Record<string, unknown>))
    // First one is c1 (current chat) so it gets excluded; remaining 35 siblings should be capped at 30
    chats[0] = { SK: 'CHAT#c1', projectId: 'proj-1', title: 'Current Chat' } as Record<string, unknown>
    mockDynamo.listChats.mockResolvedValue(chats)
    simpleStream()

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

      const [, sysPrompt] = mockBedrock.converseStream.mock.calls[0]
      // Count how many sibling chat IDs appear in the prompt
      const chatMatches = (sysPrompt as string).match(/chat\d+/g) ?? []
      expect(chatMatches.length).toBeLessThanOrEqual(30)

      const truncatedCall = consoleSpy.mock.calls.find(args =>
        typeof args[0] === 'string' && args[0].includes('manifest_truncated') && args[0].includes('"kind":"chats"')
      )
      expect(truncatedCall).toBeDefined()
      const parsed = JSON.parse(truncatedCall![0] as string)
      expect(parsed).toMatchObject({
        event: 'manifest_truncated',
        kind: 'chats',
        total: 35,
        kept: 30,
        projectId: expect.any(String),
        chatId: expect.any(String),
      })
    } finally {
      consoleSpy.mockRestore()
    }
  })

  test('P13: 3 always-files of 40000 chars each → only first two included, forced_files_truncated logged', async () => {
    projectBase()
    const alwaysFiles = [
      { fileId: 'fa1', filename: 'big1.txt', contentType: 'text/plain', status: 'ready', inclusion: 'always', s3Key: 'k/big1.txt' },
      { fileId: 'fa2', filename: 'big2.txt', contentType: 'text/plain', status: 'ready', inclusion: 'always', s3Key: 'k/big2.txt' },
      { fileId: 'fa3', filename: 'big3.txt', contentType: 'text/plain', status: 'ready', inclusion: 'always', s3Key: 'k/big3.txt' },
    ] as Record<string, unknown>[]
    mockDynamo.listProjectFiles.mockResolvedValue(alwaysFiles)
    // Each file returns 40000 chars; first two fit (80000 total), third would exceed 80000
    mockProjectFiles.fetchS3Text.mockResolvedValue('x'.repeat(40000))
    simpleStream()

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: MODEL, systemPrompt: '' }))

      const [, sysPrompt] = mockBedrock.converseStream.mock.calls[0]
      // The forced-files section starts with "Always-included project files (full content):"
      const forcedSection = (sysPrompt as string).split('Always-included project files (full content):')[1] ?? ''
      expect(forcedSection).toContain('big1.txt')
      expect(forcedSection).toContain('big2.txt')
      expect(forcedSection).not.toContain('big3.txt')

      const truncatedCall = consoleSpy.mock.calls.find(args =>
        typeof args[0] === 'string' && args[0].includes('forced_files_truncated')
      )
      expect(truncatedCall).toBeDefined()
      const parsed = JSON.parse(truncatedCall![0] as string)
      expect(parsed).toMatchObject({
        event: 'forced_files_truncated',
        projectId: expect.any(String),
        chatId: expect.any(String),
      })
    } finally {
      consoleSpy.mockRestore()
    }
  })
})
