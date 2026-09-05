import { runResearchTask, RESEARCH_FINDING_CAP } from '../../src/lib/subAgent'
import { converseStream } from '../../src/lib/llm/loop'
import type { ToolContext } from '../../src/lib/tools'

jest.mock('../../src/lib/llm/loop', () => ({
  converseStream: jest.fn(),
}))

const mockConverseStream = converseStream as jest.MockedFunction<typeof converseStream>

// Helper: build an async generator yielding the given chunks, to stand in for converseStream.
async function* fakeStream(chunks: unknown[]) {
  for (const c of chunks) yield c as never
}

const BASE_CTX: ToolContext = { sub: 'user-1', chatId: 'chat-1', modelId: 'global.anthropic.claude-sonnet-5' }

beforeEach(() => {
  mockConverseStream.mockReset()
})

test('missing question → isError, converseStream never called', async () => {
  const result = await runResearchTask({}, BASE_CTX)
  expect(result.isError).toBe(true)
  expect(mockConverseStream).not.toHaveBeenCalled()
})

test('blank question → isError, converseStream never called', async () => {
  const result = await runResearchTask({ question: '   ' }, BASE_CTX)
  expect(result.isError).toBe(true)
  expect(mockConverseStream).not.toHaveBeenCalled()
})

test('nested call increments subAgentDepth on the ctx passed to converseStream', async () => {
  mockConverseStream.mockReturnValue(fakeStream([
    { type: 'turn', role: 'assistant', content: [{ kind: 'text', text: 'Answer.' }], turnIndex: 0 },
  ]))
  await runResearchTask({ question: 'What is the visa fee?' }, { ...BASE_CTX, subAgentDepth: 1 })
  const optsArg = mockConverseStream.mock.calls[0][3] as { ctx?: ToolContext }
  expect(optsArg.ctx?.subAgentDepth).toBe(2)
})

test('final assistant turn text is capped at RESEARCH_FINDING_CAP', async () => {
  const longText = 'x'.repeat(RESEARCH_FINDING_CAP + 5000)
  mockConverseStream.mockReturnValue(fakeStream([
    { type: 'turn', role: 'assistant', content: [{ kind: 'text', text: longText }], turnIndex: 0 },
  ]))
  const result = await runResearchTask({ question: 'A self-contained question.' }, BASE_CTX)
  expect(result.isError).toBe(false)
  expect(result.entries[0].kind).toBe('text')
  expect((result.entries[0] as { text: string }).text.length).toBeLessThanOrEqual(RESEARCH_FINDING_CAP)
})

test('a throw from converseStream becomes an isError result', async () => {
  mockConverseStream.mockImplementation(() => {
    throw new Error('Bedrock unavailable')
  })
  const result = await runResearchTask({ question: 'A self-contained question.' }, BASE_CTX)
  expect(result.isError).toBe(true)
  expect((result.entries[0] as { text: string }).text).toContain('Bedrock unavailable')
})

test('no final text produced → isError', async () => {
  mockConverseStream.mockReturnValue(fakeStream([
    { type: 'stop', stopReason: 'end_turn' },
  ]))
  const result = await runResearchTask({ question: 'A self-contained question.' }, BASE_CTX)
  expect(result.isError).toBe(true)
})

test('tool_call chunks are narrated via ctx.onProgress', async () => {
  mockConverseStream.mockReturnValue(fakeStream([
    { type: 'tool_call', toolUseId: 't1', name: 'web_search', input: JSON.stringify({ query: 'IEC Canada fees' }) },
    { type: 'turn', role: 'assistant', content: [{ kind: 'text', text: 'Answer.' }], turnIndex: 0 },
  ]))
  const onProgress = jest.fn()
  await runResearchTask({ question: 'A self-contained question.' }, { ...BASE_CTX, onProgress })
  expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('IEC Canada fees'))
})
