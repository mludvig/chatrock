import { enrichUserFacts, enrichProjectFacts, summarizeChat, summarizeChatById, generateChatTitle, safeParse } from '../../src/lib/enrichment'
import * as bedrock from '../../src/lib/bedrock'
import * as dynamo from '../../src/lib/dynamo'
import * as treeLib from '../../src/lib/tree'

jest.mock('../../src/lib/bedrock')
jest.mock('../../src/lib/dynamo', () => ({
  ...jest.requireActual('../../src/lib/dynamo'),
  listMessages: jest.fn(),
  updateChatSummary: jest.fn(),
}))
jest.mock('../../src/lib/tree', () => ({
  ...jest.requireActual('../../src/lib/tree'),
  buildActivePath: jest.fn(),
}))

const mockBedrock = bedrock as jest.Mocked<typeof bedrock>
const mockDynamo = dynamo as jest.Mocked<typeof dynamo>
const mockTree = treeLib as jest.Mocked<typeof treeLib>

beforeEach(() => jest.clearAllMocks())

const TRANSCRIPT = 'User: Hi, I am Alice from Wellington.\nAssistant: Nice to meet you!'
const EXISTING_USER_MEMS = [{ memId: 'mem-1', category: 'identity', text: 'User is a software engineer' }]
const EXISTING_PROJECT_MEMS = [{ memId: 'proj-1', category: 'decision', text: 'Deploy via ./deploy.sh' }]

// ── safeParse ────────────────────────────────────────────────────────────────

test('safeParse — parses clean JSON directly', () => {
  expect(safeParse('{"summary": "hi", "sourceUrls": []}')).toEqual({ summary: 'hi', sourceUrls: [] })
})

test('safeParse — extracts the outermost {...} span when the model prepends a sentence before the JSON', () => {
  const raw = 'I have sufficient information to answer now.\n\n{"summary": "hi", "sourceUrls": []}'
  expect(safeParse(raw)).toEqual({ summary: 'hi', sourceUrls: [] })
})

test('safeParse — returns null when no JSON object is present', () => {
  expect(safeParse('just plain prose, no braces here')).toBeNull()
})

test('safeParse — returns null for a bare array even after brace extraction', () => {
  expect(safeParse('here you go: [1, 2, 3]')).toBeNull()
})

// ── enrichUserFacts ───────────────────────────────────────────────────────────

test('enrichUserFacts — returns updated memory list with new item', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    memories: [
      { memId: 'mem-1', category: 'identity', text: 'User is a software engineer' },
      { memId: null, category: 'identity', text: 'User is Alice from Wellington' },
    ],
  }))
  const result = await enrichUserFacts(TRANSCRIPT, EXISTING_USER_MEMS)
  expect(result.memories).toHaveLength(2)
  expect(result.memories[1].text).toBe('User is Alice from Wellington')
  expect(result.memories[1].memId).toBeNull()
})

test('enrichUserFacts — falls back to existing list on malformed output and logs the failure', async () => {
  mockBedrock.converseOnce.mockResolvedValue('not json')
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  const result = await enrichUserFacts(TRANSCRIPT, EXISTING_USER_MEMS, 'chat-1')
  const logged = errorSpy.mock.calls.map(c => JSON.parse(c[0] as string) as Record<string, unknown>)
  errorSpy.mockRestore()
  expect(result.memories).toHaveLength(1)
  expect(result.memories[0].memId).toBe('mem-1')
  expect(logged.some(l => l.event === 'enrich_user_facts_parse_error' && l.chatId === 'chat-1')).toBe(true)
})

test('enrichUserFacts — falls back to existing list when Bedrock throws and logs the failure', async () => {
  mockBedrock.converseOnce.mockRejectedValue(new Error('network'))
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  const result = await enrichUserFacts(TRANSCRIPT, EXISTING_USER_MEMS, 'chat-1')
  const logged = errorSpy.mock.calls.map(c => JSON.parse(c[0] as string) as Record<string, unknown>)
  errorSpy.mockRestore()
  expect(result.memories).toHaveLength(1)
  expect(result.memories[0].memId).toBe('mem-1')
  expect(logged.some(l => l.event === 'enrich_user_facts_error' && l.chatId === 'chat-1' && (l.error as string).includes('network'))).toBe(true)
})

test('enrichUserFacts — filters out invalid category values', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    memories: [
      { memId: null, category: 'identity', text: 'Valid fact' },
      { memId: null, category: 'invalid_cat', text: 'Should be filtered' },
    ],
  }))
  const result = await enrichUserFacts(TRANSCRIPT, [])
  expect(result.memories).toHaveLength(1)
  expect(result.memories[0].text).toBe('Valid fact')
})

test('enrichUserFacts — passes existing memories in user message', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ memories: [] }))
  await enrichUserFacts(TRANSCRIPT, EXISTING_USER_MEMS)
  const userMsg = (mockBedrock.converseOnce.mock.calls[0][2][0].content![0] as { text: string }).text
  expect(userMsg).toContain('CURRENT_MEMORIES')
  expect(userMsg).toContain('mem-1')
})

test('enrichUserFacts — system prompt contains PII guardrails', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ memories: [] }))
  await enrichUserFacts(TRANSCRIPT, [])
  const systemPrompt = mockBedrock.converseOnce.mock.calls[0][1]
  expect(systemPrompt).toContain('NEVER capture')
  expect(systemPrompt).toContain('third parties')
})

test('enrichUserFacts — strips markdown code fences', async () => {
  mockBedrock.converseOnce.mockResolvedValue('```json\n{"memories":[{"memId":null,"category":"identity","text":"Alice"}]}\n```')
  const result = await enrichUserFacts(TRANSCRIPT, [])
  expect(result.memories).toHaveLength(1)
  expect(result.memories[0].text).toBe('Alice')
})

test('enrichUserFacts — empty memories array falls back to existing', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ memories: [] }))
  const result = await enrichUserFacts(TRANSCRIPT, EXISTING_USER_MEMS)
  // Empty returned list → fall back (model said nothing new, don't wipe)
  expect(result.memories).toHaveLength(1)
  expect(result.memories[0].memId).toBe('mem-1')
})

// ── generateChatTitle ────────────────────────────────────────────────────────

test('generateChatTitle — returns trimmed title text from the model', async () => {
  mockBedrock.converseOnce.mockResolvedValue('  Introduction chat  ')
  const title = await generateChatTitle(TRANSCRIPT)
  expect(title).toBe('Introduction chat')
})

test('generateChatTitle — uses the dedicated cheap title model', async () => {
  mockBedrock.converseOnce.mockResolvedValue('Some title')
  await generateChatTitle(TRANSCRIPT)
  const [modelId] = mockBedrock.converseOnce.mock.calls[0]
  expect(modelId).toBe('global.anthropic.claude-haiku-4-5-20251001-v1:0')
})

test('generateChatTitle — returns undefined and logs when the model throws', async () => {
  mockBedrock.converseOnce.mockRejectedValue(new Error('throttled'))
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  const title = await generateChatTitle(TRANSCRIPT, 'chat-1')
  const logged = errorSpy.mock.calls.map(c => JSON.parse(c[0] as string) as Record<string, unknown>)
  errorSpy.mockRestore()
  expect(title).toBeUndefined()
  expect(logged.some(l => l.event === 'generate_title_error' && l.chatId === 'chat-1' && (l.error as string).includes('throttled'))).toBe(true)
})

test('generateChatTitle — returns undefined and logs when the model returns empty text', async () => {
  mockBedrock.converseOnce.mockResolvedValue('   ')
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  const title = await generateChatTitle(TRANSCRIPT, 'chat-1')
  const logged = errorSpy.mock.calls.map(c => JSON.parse(c[0] as string) as Record<string, unknown>)
  errorSpy.mockRestore()
  expect(title).toBeUndefined()
  expect(logged.some(l => l.event === 'generate_title_empty_response' && l.chatId === 'chat-1')).toBe(true)
})

test('generateChatTitle — is independent of enrichUserFacts: a memory parse failure does not block titling', async () => {
  // First call (enrichUserFacts) returns malformed JSON; second call (generateChatTitle) succeeds.
  mockBedrock.converseOnce
    .mockResolvedValueOnce('not json')
    .mockResolvedValueOnce('Recovered title')
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  const userResult = await enrichUserFacts(TRANSCRIPT, EXISTING_USER_MEMS)
  const title = await generateChatTitle(TRANSCRIPT)
  errorSpy.mockRestore()
  expect(userResult.memories).toHaveLength(1) // fell back, but didn't throw
  expect(title).toBe('Recovered title') // unaffected by the memory-extraction failure
})

// ── enrichProjectFacts ────────────────────────────────────────────────────────

test('enrichProjectFacts — returns updated memory list', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    memories: [
      { memId: 'proj-1', category: 'decision', text: 'Deploy via ./deploy.sh' },
      { memId: null, category: 'fact', text: 'Project uses TypeScript' },
    ],
  }))
  const result = await enrichProjectFacts(TRANSCRIPT, EXISTING_PROJECT_MEMS)
  expect(result.memories).toHaveLength(2)
})

test('enrichProjectFacts — falls back to existing list on malformed output and logs the failure', async () => {
  mockBedrock.converseOnce.mockResolvedValue('bad json')
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  const result = await enrichProjectFacts(TRANSCRIPT, EXISTING_PROJECT_MEMS, 'chat-1')
  const logged = errorSpy.mock.calls.map(c => JSON.parse(c[0] as string) as Record<string, unknown>)
  errorSpy.mockRestore()
  expect(result.memories).toHaveLength(1)
  expect(result.memories[0].memId).toBe('proj-1')
  expect(logged.some(l => l.event === 'enrich_project_facts_parse_error' && l.chatId === 'chat-1')).toBe(true)
})

test('enrichProjectFacts — filters out invalid category values', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    memories: [
      { memId: null, category: 'decision', text: 'Valid project fact' },
      { memId: null, category: 'identity', text: 'Wrong category for project' },
    ],
  }))
  const result = await enrichProjectFacts(TRANSCRIPT, [])
  expect(result.memories).toHaveLength(1)
  expect(result.memories[0].text).toBe('Valid project fact')
})

test('enrichProjectFacts — passes existing memories in user message', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ memories: [] }))
  await enrichProjectFacts(TRANSCRIPT, EXISTING_PROJECT_MEMS)
  const userMsg = (mockBedrock.converseOnce.mock.calls[0][2][0].content![0] as { text: string }).text
  expect(userMsg).toContain('CURRENT_MEMORIES')
  expect(userMsg).toContain('proj-1')
})

test('enrichProjectFacts — system prompt requires user provenance and excludes general knowledge', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ memories: [] }))
  await enrichProjectFacts(TRANSCRIPT, [])
  const systemPrompt = mockBedrock.converseOnce.mock.calls[0][1]
  expect(systemPrompt).toContain('PROVENANCE IS DECISIVE')
  expect(systemPrompt).toContain('Never capture')
})

// ── summarizeChat ─────────────────────────────────────────────────────────────

test('summarizeChat — returns merged summary and topics', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    summary: 'User and assistant discussed deploying via ./deploy.sh.',
    topics: ['deployment pipeline', 'terraform apply'],
  }))
  const result = await summarizeChat(TRANSCRIPT, '', [])
  expect(result.summary).toBe('User and assistant discussed deploying via ./deploy.sh.')
  expect(result.topics).toEqual(['deployment pipeline', 'terraform apply'])
})

test('summarizeChat — passes existing summary and topics in user message', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ summary: '', topics: [] }))
  await summarizeChat(TRANSCRIPT, 'Prior summary.', ['topic a'])
  const userMsg = (mockBedrock.converseOnce.mock.calls[0][2][0].content![0] as { text: string }).text
  expect(userMsg).toContain('EXISTING_SUMMARY: Prior summary.')
  expect(userMsg).toContain('EXISTING_TOPICS: ["topic a"]')
})

test('summarizeChat — falls back to empty summary/topics on malformed output and logs the failure', async () => {
  mockBedrock.converseOnce.mockResolvedValue('not json')
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  const result = await summarizeChat(TRANSCRIPT, '', [], 'chat-1')
  const logged = errorSpy.mock.calls.map(c => JSON.parse(c[0] as string) as Record<string, unknown>)
  errorSpy.mockRestore()
  expect(result).toEqual({ summary: '', topics: [] })
  expect(logged.some(l => l.event === 'summarize_chat_parse_error' && l.chatId === 'chat-1')).toBe(true)
})

test('summarizeChat — falls back to empty summary/topics when Bedrock throws and logs the failure', async () => {
  mockBedrock.converseOnce.mockRejectedValue(new Error('network'))
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  const result = await summarizeChat(TRANSCRIPT, '', [], 'chat-1')
  const logged = errorSpy.mock.calls.map(c => JSON.parse(c[0] as string) as Record<string, unknown>)
  errorSpy.mockRestore()
  expect(result).toEqual({ summary: '', topics: [] })
  expect(logged.some(l => l.event === 'summarize_chat_error' && l.chatId === 'chat-1')).toBe(true)
})

test('summarizeChat — filters non-string topics and caps at 8', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    summary: 'x',
    topics: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 42, null, ''],
  }))
  const result = await summarizeChat(TRANSCRIPT, '', [])
  expect(result.topics).toHaveLength(8)
  expect(result.topics).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
})

// ── summarizeChatById ─────────────────────────────────────────────────────────

const FAKE_ROWS = [
  { msgId: 'm1', parentId: null, role: 'user', blocks: [{ text: 'Hello project' }] },
  { msgId: 'm2', parentId: 'm1', role: 'assistant', blocks: [{ text: 'Hi from the project' }] },
]

test('summarizeChatById — calls updateChatSummary when summary or topics are returned', async () => {
  mockDynamo.listMessages.mockResolvedValue(FAKE_ROWS as unknown as Record<string, unknown>[])
  mockTree.buildActivePath.mockReturnValue(FAKE_ROWS as any)
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    summary: 'A project chat about greetings.',
    topics: ['greetings'],
  }))
  mockDynamo.updateChatSummary.mockResolvedValue(undefined)

  const result = await summarizeChatById('user-1', 'chat-1')

  expect(result).toEqual({ summary: 'A project chat about greetings.', topics: ['greetings'] })
  expect(mockDynamo.updateChatSummary).toHaveBeenCalledWith('user-1', 'chat-1', {
    summary: 'A project chat about greetings.',
    topics: ['greetings'],
  })
})

test('summarizeChatById — no updateChatSummary when neither summary nor topics returned', async () => {
  mockDynamo.listMessages.mockResolvedValue(FAKE_ROWS as unknown as Record<string, unknown>[])
  mockTree.buildActivePath.mockReturnValue(FAKE_ROWS as any)
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ summary: '', topics: [] }))

  const result = await summarizeChatById('user-1', 'chat-1')

  expect(result).toEqual({ summary: '', topics: [] })
  expect(mockDynamo.updateChatSummary).not.toHaveBeenCalled()
})

test('summarizeChatById — returns undefined when chat has no messages (never throws)', async () => {
  mockDynamo.listMessages.mockResolvedValue([])

  const result = await summarizeChatById('user-1', 'empty-chat')

  expect(result).toBeUndefined()
  expect(mockDynamo.updateChatSummary).not.toHaveBeenCalled()
})

test('summarizeChatById — returns undefined on error (never throws)', async () => {
  mockDynamo.listMessages.mockRejectedValue(new Error('DB error'))

  const result = await summarizeChatById('user-1', 'chat-1')

  expect(result).toBeUndefined()
})

test('summarizeChatById — passes empty existing summary/topics (fresh rebuild, not a merge)', async () => {
  mockDynamo.listMessages.mockResolvedValue(FAKE_ROWS as unknown as Record<string, unknown>[])
  mockTree.buildActivePath.mockReturnValue(FAKE_ROWS as any)
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ summary: 'test', topics: [] }))

  await summarizeChatById('user-1', 'chat-1')

  const userMsg = (mockBedrock.converseOnce.mock.calls[0][2][0].content![0] as { text: string }).text
  expect(userMsg).toContain('EXISTING_SUMMARY: (none yet)')
  expect(userMsg).toContain('EXISTING_TOPICS: []')
})
