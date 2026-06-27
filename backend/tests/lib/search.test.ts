import { searchHistory, SEARCH_HISTORY_CORPUS_CAP, type SearchHistoryCorpusItem } from '../../src/lib/search'
import * as bedrock from '../../src/lib/bedrock'

jest.mock('../../src/lib/bedrock')

const mockBedrock = bedrock as jest.Mocked<typeof bedrock>

beforeEach(() => jest.clearAllMocks())

const CHAT_ITEM: SearchHistoryCorpusItem = {
  kind: 'chat',
  id: 'chat-1',
  title: 'Athena cost tuning',
  topics: ['Athena', 'partition pruning'],
  summary: 'Discussed reducing Athena scan costs via partition pruning.',
}

const FILE_ITEM: SearchHistoryCorpusItem = {
  kind: 'file',
  id: 'file-1',
  title: 'glue-design.md',
  summary: 'Design notes for the Glue partition layout.',
  projectId: 'proj-1',
}

test('searchHistory — maps a valid {results:[...]} response back to corpus items, preserving model order', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    results: [
      { id: 'file:file-1', reason: 'Matches partition design' },
      { id: 'chat:chat-1', reason: 'Discusses Athena cost' },
    ],
  }))
  const result = await searchHistory([CHAT_ITEM, FILE_ITEM], 'athena partitioning')
  expect(result).toEqual([
    { kind: 'file', id: 'file-1', title: 'glue-design.md', reason: 'Matches partition design', projectId: 'proj-1' },
    { kind: 'chat', id: 'chat-1', title: 'Athena cost tuning', reason: 'Discusses Athena cost' },
  ])
})

test('searchHistory — bare array response (no object wrapper) is rejected by safeParse and yields []', async () => {
  // safeParse requires a plain object — a bare array must NOT be treated as valid.
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify([{ id: 'chat:chat-1', reason: 'x' }]))
  const result = await searchHistory([CHAT_ITEM], 'athena')
  expect(result).toEqual([])
})

test('searchHistory — malformed JSON yields []', async () => {
  mockBedrock.converseOnce.mockResolvedValue('not json')
  const result = await searchHistory([CHAT_ITEM], 'athena')
  expect(result).toEqual([])
})

test('searchHistory — Bedrock throwing yields [] rather than propagating', async () => {
  mockBedrock.converseOnce.mockRejectedValue(new Error('network'))
  const result = await searchHistory([CHAT_ITEM], 'athena')
  expect(result).toEqual([])
})

test('searchHistory — drops a hallucinated id not present in the corpus', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    results: [
      { id: 'chat:chat-1', reason: 'real match' },
      { id: 'chat:does-not-exist', reason: 'hallucinated' },
    ],
  }))
  const result = await searchHistory([CHAT_ITEM], 'athena')
  expect(result).toHaveLength(1)
  expect(result[0].id).toBe('chat-1')
})

test('searchHistory — empty corpus short-circuits without calling Bedrock', async () => {
  const result = await searchHistory([], 'athena')
  expect(result).toEqual([])
  expect(mockBedrock.converseOnce).not.toHaveBeenCalled()
})

test('searchHistory — blank query short-circuits without calling Bedrock', async () => {
  const result = await searchHistory([CHAT_ITEM], '   ')
  expect(result).toEqual([])
  expect(mockBedrock.converseOnce).not.toHaveBeenCalled()
})

test('searchHistory — caps an oversized corpus to SEARCH_HISTORY_CORPUS_CAP and logs search_history_truncated', async () => {
  const bigCorpus: SearchHistoryCorpusItem[] = Array.from({ length: SEARCH_HISTORY_CORPUS_CAP + 25 }, (_, i) => ({
    kind: 'chat' as const,
    id: `chat-${i}`,
    title: `Chat ${i}`,
    summary: `Summary ${i}`,
  }))
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ results: [] }))
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  await searchHistory(bigCorpus, 'anything', { scope: 'global', chatId: 'chat-x' })
  const logged = logSpy.mock.calls.map(c => JSON.parse(c[0] as string) as Record<string, unknown>)
  logSpy.mockRestore()
  expect(logged.some(l =>
    l.event === 'search_history_truncated' && l.total === bigCorpus.length && l.kept === SEARCH_HISTORY_CORPUS_CAP
    && l.scope === 'global' && l.chatId === 'chat-x',
  )).toBe(true)
  // Only the kept slice should appear in the prompt sent to the model.
  const userMsg = (mockBedrock.converseOnce.mock.calls[0][2][0].content![0] as { text: string }).text
  expect(userMsg).toContain(`chat-${SEARCH_HISTORY_CORPUS_CAP - 1}`)
  expect(userMsg).not.toContain(`chat-${SEARCH_HISTORY_CORPUS_CAP}`)
})

test('searchHistory — corpus line format includes bracketed kind:id token, title, topics and summary', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ results: [] }))
  await searchHistory([CHAT_ITEM, FILE_ITEM], 'athena')
  const userMsg = (mockBedrock.converseOnce.mock.calls[0][2][0].content![0] as { text: string }).text
  expect(userMsg).toContain('[chat:chat-1] Athena cost tuning')
  expect(userMsg).toContain('Athena, partition pruning')
  expect(userMsg).toContain('[file:file-1] glue-design.md')
})

test('searchHistory — never throws even when both corpus mapping and Bedrock are unusual', async () => {
  mockBedrock.converseOnce.mockResolvedValue(undefined as unknown as string)
  await expect(searchHistory([CHAT_ITEM], 'athena')).resolves.toEqual([])
})
