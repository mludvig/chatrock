import { enrichUserFacts, enrichProjectFacts, enrichChatForProject, generateChatTitle } from '../../src/lib/enrichment'
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

test('enrichProjectFacts — returns updated memory list and summary', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    memories: [
      { memId: 'proj-1', category: 'decision', text: 'Deploy via ./deploy.sh' },
      { memId: null, category: 'fact', text: 'Project uses TypeScript' },
    ],
    summary: 'Chat about the deployment pipeline.',
  }))
  const result = await enrichProjectFacts(TRANSCRIPT, EXISTING_PROJECT_MEMS)
  expect(result.memories).toHaveLength(2)
  expect(result.summary).toBe('Chat about the deployment pipeline.')
})

test('enrichProjectFacts — falls back to existing list on malformed output and logs the failure', async () => {
  mockBedrock.converseOnce.mockResolvedValue('bad json')
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  const result = await enrichProjectFacts(TRANSCRIPT, EXISTING_PROJECT_MEMS, 'chat-1')
  const logged = errorSpy.mock.calls.map(c => JSON.parse(c[0] as string) as Record<string, unknown>)
  errorSpy.mockRestore()
  expect(result.memories).toHaveLength(1)
  expect(result.memories[0].memId).toBe('proj-1')
  expect(result.summary).toBeUndefined()
  expect(logged.some(l => l.event === 'enrich_project_facts_parse_error' && l.chatId === 'chat-1')).toBe(true)
})

test('enrichProjectFacts — filters out invalid category values', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    memories: [
      { memId: null, category: 'decision', text: 'Valid project fact' },
      { memId: null, category: 'identity', text: 'Wrong category for project' },
    ],
    summary: 'Test.',
  }))
  const result = await enrichProjectFacts(TRANSCRIPT, [])
  expect(result.memories).toHaveLength(1)
  expect(result.memories[0].text).toBe('Valid project fact')
})

test('enrichProjectFacts — passes existing memories in user message', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ memories: [], summary: 'test' }))
  await enrichProjectFacts(TRANSCRIPT, EXISTING_PROJECT_MEMS)
  const userMsg = (mockBedrock.converseOnce.mock.calls[0][2][0].content![0] as { text: string }).text
  expect(userMsg).toContain('CURRENT_MEMORIES')
  expect(userMsg).toContain('proj-1')
})

test('enrichProjectFacts — system prompt requires user provenance and excludes general knowledge', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ memories: [], summary: '' }))
  await enrichProjectFacts(TRANSCRIPT, [])
  const systemPrompt = mockBedrock.converseOnce.mock.calls[0][1]
  expect(systemPrompt).toContain('PROVENANCE IS DECISIVE')
  expect(systemPrompt).toContain('Never capture')
})

// ── enrichChatForProject ──────────────────────────────────────────────────────

const FAKE_ROWS = [
  { msgId: 'm1', parentId: null, role: 'user', blocks: [{ text: 'Hello project' }] },
  { msgId: 'm2', parentId: 'm1', role: 'assistant', blocks: [{ text: 'Hi from the project' }] },
]

test('enrichChatForProject — calls updateChatSummary when summary is returned', async () => {
  mockDynamo.listMessages.mockResolvedValue(FAKE_ROWS as unknown as Record<string, unknown>[])
  mockTree.buildActivePath.mockReturnValue(FAKE_ROWS as any)
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    memories: [],
    summary: 'A project chat about greetings.',
  }))
  mockDynamo.updateChatSummary.mockResolvedValue(undefined)

  const result = await enrichChatForProject('user-1', 'chat-1')

  expect(result).toBe('A project chat about greetings.')
  expect(mockDynamo.updateChatSummary).toHaveBeenCalledWith('user-1', 'chat-1', 'A project chat about greetings.')
})

test('enrichChatForProject — no updateChatSummary when no summary returned', async () => {
  mockDynamo.listMessages.mockResolvedValue(FAKE_ROWS as unknown as Record<string, unknown>[])
  mockTree.buildActivePath.mockReturnValue(FAKE_ROWS as any)
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ memories: [] }))

  const result = await enrichChatForProject('user-1', 'chat-1')

  expect(result).toBeUndefined()
  expect(mockDynamo.updateChatSummary).not.toHaveBeenCalled()
})

test('enrichChatForProject — returns undefined when chat has no messages (never throws)', async () => {
  mockDynamo.listMessages.mockResolvedValue([])

  const result = await enrichChatForProject('user-1', 'empty-chat')

  expect(result).toBeUndefined()
  expect(mockDynamo.updateChatSummary).not.toHaveBeenCalled()
})

test('enrichChatForProject — returns undefined on error (never throws)', async () => {
  mockDynamo.listMessages.mockRejectedValue(new Error('DB error'))

  const result = await enrichChatForProject('user-1', 'chat-1')

  expect(result).toBeUndefined()
})

test('enrichChatForProject — passes empty existing memories (summary-only call)', async () => {
  mockDynamo.listMessages.mockResolvedValue(FAKE_ROWS as unknown as Record<string, unknown>[])
  mockTree.buildActivePath.mockReturnValue(FAKE_ROWS as any)
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ memories: [], summary: 'test' }))

  await enrichChatForProject('user-1', 'chat-1')

  const userMsg = (mockBedrock.converseOnce.mock.calls[0][2][0].content![0] as { text: string }).text
  expect(userMsg).toContain('CURRENT_MEMORIES: []')
})
