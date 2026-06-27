import { findContext, FIND_CORPUS_CAP, type FindCorpusItem } from '../../src/lib/find'
import * as bedrock from '../../src/lib/bedrock'

jest.mock('../../src/lib/bedrock')

const mockBedrock = bedrock as jest.Mocked<typeof bedrock>

beforeEach(() => jest.clearAllMocks())

const CHAT_ITEM: FindCorpusItem = {
  kind: 'chat',
  id: 'chat-1',
  title: 'Athena cost tuning',
  topics: ['Athena', 'partition pruning'],
  summary: 'Discussed reducing Athena scan costs via partition pruning.',
}

const FILE_ITEM: FindCorpusItem = {
  kind: 'file',
  id: 'file-1',
  title: 'glue-design.md',
  summary: 'Design notes for the Glue partition layout.',
  projectId: 'proj-1',
}

test('findContext — maps a valid {results:[...]} response back to corpus items, preserving model order', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    results: [
      { id: 'file:file-1', reason: 'Matches partition design' },
      { id: 'chat:chat-1', reason: 'Discusses Athena cost' },
    ],
  }))
  const result = await findContext([CHAT_ITEM, FILE_ITEM], 'athena partitioning')
  expect(result).toEqual([
    { kind: 'file', id: 'file-1', title: 'glue-design.md', reason: 'Matches partition design', projectId: 'proj-1' },
    { kind: 'chat', id: 'chat-1', title: 'Athena cost tuning', reason: 'Discusses Athena cost' },
  ])
})

test('findContext — bare array response (no object wrapper) is rejected by safeParse and yields []', async () => {
  // safeParse requires a plain object — a bare array must NOT be treated as valid.
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify([{ id: 'chat:chat-1', reason: 'x' }]))
  const result = await findContext([CHAT_ITEM], 'athena')
  expect(result).toEqual([])
})

test('findContext — malformed JSON yields []', async () => {
  mockBedrock.converseOnce.mockResolvedValue('not json')
  const result = await findContext([CHAT_ITEM], 'athena')
  expect(result).toEqual([])
})

test('findContext — Bedrock throwing yields [] rather than propagating', async () => {
  mockBedrock.converseOnce.mockRejectedValue(new Error('network'))
  const result = await findContext([CHAT_ITEM], 'athena')
  expect(result).toEqual([])
})

test('findContext — drops a hallucinated id not present in the corpus', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    results: [
      { id: 'chat:chat-1', reason: 'real match' },
      { id: 'chat:does-not-exist', reason: 'hallucinated' },
    ],
  }))
  const result = await findContext([CHAT_ITEM], 'athena')
  expect(result).toHaveLength(1)
  expect(result[0].id).toBe('chat-1')
})

test('findContext — empty corpus short-circuits without calling Bedrock', async () => {
  const result = await findContext([], 'athena')
  expect(result).toEqual([])
  expect(mockBedrock.converseOnce).not.toHaveBeenCalled()
})

test('findContext — blank query short-circuits without calling Bedrock', async () => {
  const result = await findContext([CHAT_ITEM], '   ')
  expect(result).toEqual([])
  expect(mockBedrock.converseOnce).not.toHaveBeenCalled()
})

test('findContext — caps an oversized corpus to FIND_CORPUS_CAP and logs find_truncated', async () => {
  const bigCorpus: FindCorpusItem[] = Array.from({ length: FIND_CORPUS_CAP + 25 }, (_, i) => ({
    kind: 'chat' as const,
    id: `chat-${i}`,
    title: `Chat ${i}`,
    summary: `Summary ${i}`,
  }))
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ results: [] }))
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  await findContext(bigCorpus, 'anything', { scope: 'global', chatId: 'chat-x' })
  const logged = logSpy.mock.calls.map(c => JSON.parse(c[0] as string) as Record<string, unknown>)
  logSpy.mockRestore()
  expect(logged.some(l =>
    l.event === 'find_truncated' && l.total === bigCorpus.length && l.kept === FIND_CORPUS_CAP
    && l.scope === 'global' && l.chatId === 'chat-x',
  )).toBe(true)
  // Only the kept slice should appear in the prompt sent to the model.
  const userMsg = (mockBedrock.converseOnce.mock.calls[0][2][0].content![0] as { text: string }).text
  expect(userMsg).toContain(`chat-${FIND_CORPUS_CAP - 1}`)
  expect(userMsg).not.toContain(`chat-${FIND_CORPUS_CAP}`)
})

test('findContext — corpus line format includes bracketed kind:id token, title, topics and summary', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ results: [] }))
  await findContext([CHAT_ITEM, FILE_ITEM], 'athena')
  const userMsg = (mockBedrock.converseOnce.mock.calls[0][2][0].content![0] as { text: string }).text
  expect(userMsg).toContain('[chat:chat-1] Athena cost tuning')
  expect(userMsg).toContain('Athena, partition pruning')
  expect(userMsg).toContain('[file:file-1] glue-design.md')
})

test('findContext — never throws even when both corpus mapping and Bedrock are unusual', async () => {
  mockBedrock.converseOnce.mockResolvedValue(undefined as unknown as string)
  await expect(findContext([CHAT_ITEM], 'athena')).resolves.toEqual([])
})
