import { buildHandler } from '../../src/ws/sendMessage'
import * as dynamo from '../../src/lib/dynamo'
import * as bedrock from '../../src/lib/bedrock'

jest.mock('../../src/lib/dynamo')
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

test('streams tokens and persists user + assistant messages', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: 'x', systemPrompt: '', title: 'New Chat' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatTitle.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'delta' as const, text: 'Hello' }
    yield { type: 'delta' as const, text: ' world' }
    yield { type: 'stop'  as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())
  mockBedrock.converseOnce.mockResolvedValue('Test Title')

  const handler = buildHandler(mockPost)
  await handler(makeEvent({ chatId: 'c1', content: 'Hi', model: 'x', systemPrompt: '' }))

  // Two delta posts + one done post
  const dataPayloads = mockPost.mock.calls.map(c => JSON.parse(c[0].Data))
  expect(dataPayloads.filter((d: {type: string}) => d.type === 'delta')).toHaveLength(2)
  expect(dataPayloads.find((d: {type: string}) => d.type === 'done')).toBeDefined()

  // User message + assistant message persisted
  expect(mockDynamo.putMessage).toHaveBeenCalledTimes(2)
  expect(mockDynamo.putMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', content: 'Hi' }))
  const assistantCall = mockDynamo.putMessage.mock.calls.find(
    c => (c[0] as {role: string}).role === 'assistant',
  )![0] as Record<string, unknown>
  expect(assistantCall).toMatchObject({ role: 'assistant', content: 'Hello world' })
  // Plain-text stream must NOT persist empty thinking/toolCalls keys
  expect(assistantCall).not.toHaveProperty('thinking')
  expect(assistantCall).not.toHaveProperty('toolCalls')
})

// ── Slice 2 tests: persist thinking + tool calls ──────────────────────────────

test('persists thinking text and tool call results on assistant message', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: 'x', systemPrompt: '', title: 'Existing' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'thinking_delta' as const, text: 'Let me ' }
    yield { type: 'thinking_delta' as const, text: 'search.' }
    yield { type: 'thinking_done' as const }
    yield { type: 'tool_call_start' as const, toolUseId: 't1', name: 'web_search' }
    yield { type: 'tool_call' as const, toolUseId: 't1', name: 'web_search', input: '{"query":"foo"}' }
    yield { type: 'tool_result' as const, toolUseId: 't1', name: 'web_search', content: '{"results":[{"title":"T","url":"https://x.com","description":"D"}]}', isError: false }
    yield { type: 'delta' as const, text: 'Here' }
    yield { type: 'delta' as const, text: ' you go' }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: 'x', systemPrompt: '' }))

  const assistantCall = mockDynamo.putMessage.mock.calls.find(
    c => (c[0] as {role: string}).role === 'assistant',
  )![0] as Record<string, unknown>

  expect(assistantCall).toMatchObject({
    role: 'assistant',
    content: 'Here you go',
    thinking: 'Let me search.',
  })
  expect(assistantCall.toolCalls).toEqual([
    expect.objectContaining({
      toolUseId: 't1',
      name: 'web_search',
      input: '{"query":"foo"}',
      result: '{"results":[{"title":"T","url":"https://x.com","description":"D"}]}',
      isError: false,
    }),
  ])
  // searchResults must NOT be persisted — it's derived on load
  const tc0 = (assistantCall.toolCalls as Record<string, unknown>[])[0]
  expect(tc0).not.toHaveProperty('searchResults')
})

test('merges multi-round tool calls into one assistant message', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: 'x', systemPrompt: '', title: 'Existing' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)

  // Two tool calls from different rounds, then a final text turn
  async function* fakeStream() {
    yield { type: 'thinking_delta' as const, text: 'r0' }
    yield { type: 'tool_call_start' as const, toolUseId: 't1', name: 'web_search' }
    yield { type: 'tool_call' as const, toolUseId: 't1', name: 'web_search', input: '{"query":"r0"}' }
    yield { type: 'tool_result' as const, toolUseId: 't1', name: 'web_search', content: 'res0', isError: false }
    yield { type: 'thinking_delta' as const, text: 'r1' }
    yield { type: 'tool_call_start' as const, toolUseId: 't2', name: 'web_fetch' }
    yield { type: 'tool_call' as const, toolUseId: 't2', name: 'web_fetch', input: '{"url":"https://x.com"}' }
    yield { type: 'tool_result' as const, toolUseId: 't2', name: 'web_fetch', content: 'fetched', isError: false }
    yield { type: 'delta' as const, text: 'done' }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: 'x', systemPrompt: '' }))

  // Only 2 putMessage calls: user + one merged assistant
  expect(mockDynamo.putMessage).toHaveBeenCalledTimes(2)

  const assistantCall = mockDynamo.putMessage.mock.calls.find(
    c => (c[0] as {role: string}).role === 'assistant',
  )![0] as Record<string, unknown>

  expect(assistantCall.thinking).toBe('r0r1')
  expect(assistantCall.content).toBe('done')
  const tcs = assistantCall.toolCalls as Record<string, unknown>[]
  expect(tcs).toHaveLength(2)
  expect(tcs[0]).toMatchObject({ toolUseId: 't1', result: 'res0' })
  expect(tcs[1]).toMatchObject({ toolUseId: 't2', result: 'fetched' })
})

test('persists assistant message even when final text is empty (tool-only/max_rounds)', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: 'x', systemPrompt: '', title: 'Existing' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)

  // No delta chunks — thinking + tool only, then stop
  async function* fakeStream() {
    yield { type: 'thinking_delta' as const, text: 'thought' }
    yield { type: 'tool_call_start' as const, toolUseId: 't1', name: 'web_search' }
    yield { type: 'tool_call' as const, toolUseId: 't1', name: 'web_search', input: '{"query":"q"}' }
    yield { type: 'tool_result' as const, toolUseId: 't1', name: 'web_search', content: 'r', isError: false }
    yield { type: 'stop' as const, stopReason: 'max_rounds' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Q', model: 'x', systemPrompt: '' }))

  // Assistant message MUST be persisted even with empty text
  const assistantCall = mockDynamo.putMessage.mock.calls.find(
    c => (c[0] as {role: string}).role === 'assistant',
  )
  expect(assistantCall).toBeDefined()
  const item = assistantCall![0] as Record<string, unknown>
  expect(item.content).toBe('')
  expect(item.thinking).toBe('thought')
  expect(item.toolCalls).toHaveLength(1)
})

test('sends titleUpdated event on first exchange', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: 'x', systemPrompt: '', title: 'New Chat' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatTitle.mockResolvedValue(undefined)

  async function* fakeStream() { yield { type: 'stop' as const, stopReason: 'end_turn' } }
  mockBedrock.converseStream.mockReturnValue(fakeStream())
  mockBedrock.converseOnce.mockResolvedValue('My Title')

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Hello', model: 'x', systemPrompt: '' }))

  const titleEvent = mockPost.mock.calls.map(c => JSON.parse(c[0].Data)).find((d: {type:string}) => d.type === 'titleUpdated')
  expect(titleEvent).toMatchObject({ type: 'titleUpdated', title: 'My Title', chatId: 'c1' })
  expect(mockDynamo.updateChatTitle).toHaveBeenCalledWith('user-1', 'c1', 'My Title')
})

test('does not re-title when chat already has a title', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: 'x', systemPrompt: '', title: 'Existing Title' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)

  async function* fakeStream() { yield { type: 'stop' as const, stopReason: 'end_turn' } }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Hello', model: 'x', systemPrompt: '' }))

  expect(mockDynamo.updateChatTitle).not.toHaveBeenCalled()
  expect(mockBedrock.converseOnce).not.toHaveBeenCalled()
})

test('returns 410 when connection not found', async () => {
  mockDynamo.getConnection.mockResolvedValue(undefined)
  const res = await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Hi', model: 'x', systemPrompt: '' })) as any
  expect(res.statusCode).toBe(410)
})

test('sends error event when chat not found', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue(undefined)

  await buildHandler(mockPost)(makeEvent({ chatId: 'missing', content: 'Hi', model: 'x', systemPrompt: '' }))

  const errEvent = mockPost.mock.calls.map(c => JSON.parse(c[0].Data)).find((d: {type:string}) => d.type === 'error')
  expect(errEvent).toBeDefined()
  expect(mockDynamo.putMessage).not.toHaveBeenCalled()
})
