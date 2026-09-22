import { converseStream } from '../../../src/lib/llm/loop'
import { getProvider } from '../../../src/lib/llm/registry'
import { executeTool } from '../../../src/lib/tools'
import type { ChatProvider, TurnRequest, TurnResult } from '../../../src/lib/llm/types'
import { DEFAULT_CHAT_MODEL } from '../../../src/config/models'

jest.mock('../../../src/lib/llm/registry', () => ({
  getProvider: jest.fn(),
}))

jest.mock('../../../src/lib/tools', () => ({
  ...jest.requireActual('../../../src/lib/tools'),
  executeTool: jest.fn(),
}))

const mockGetProvider = getProvider as jest.MockedFunction<typeof getProvider>
const mockExecuteTool = executeTool as jest.MockedFunction<typeof executeTool>

const TEST_CALL = { purpose: 'chat' } as const

function textResult(text: string, stopReason = 'end_turn'): TurnResult {
  return {
    stopReason,
    toolUses: [],
    content: [{ kind: 'text', text }],
  }
}

function toolUseResult(): TurnResult {
  return {
    stopReason: 'tool_use',
    toolUses: [{ callId: 'call-1', name: 'web_search', inputJson: '{"query":"x"}' }],
    content: [{ kind: 'tool_call', callId: 'call-1', name: 'web_search', input: { query: 'x' } }],
  }
}

beforeEach(() => {
  mockGetProvider.mockReset()
  mockExecuteTool.mockReset()
})

test('a deadline already past skips the round loop and yields one truncated final turn', async () => {
  // eslint-disable-next-line require-yield -- mock has no chunks to stream, only a final result
  const streamTurn = jest.fn(async function* (_req: TurnRequest) {
    return textResult('Best answer from what we have.', 'tool_use')
  })
  const provider: ChatProvider = { id: 'bedrock-converse', sanitizeHistory: m => m, streamTurn, once: jest.fn() }
  mockGetProvider.mockReturnValue(provider)

  const chunks = []
  for await (const c of converseStream(
    DEFAULT_CHAT_MODEL,
    'system',
    [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
    { settings: { researchDepth: 'deep' }, deadlineAt: Date.now() - 1000, call: TEST_CALL },
  )) {
    chunks.push(c)
  }

  // Only the final synthesis call should have run — no rounds attempted.
  expect(streamTurn).toHaveBeenCalledTimes(1)
  const turnChunk = chunks.find(c => c.type === 'turn' && c.role === 'assistant') as Extract<typeof chunks[number], { type: 'turn' }>
  expect(turnChunk).toBeDefined()
  expect(turnChunk.truncated).toBe(true)
  const stopChunk = chunks.find(c => c.type === 'stop') as Extract<typeof chunks[number], { type: 'stop' }>
  expect(stopChunk.stopReason).toBe('max_rounds')
})

test('sub_agent_progress chunks queued via ctx.onProgress drain out of the tool pool loop', async () => {
  let callCount = 0
  // eslint-disable-next-line require-yield -- mock has no chunks to stream, only a final result
  const streamTurn = jest.fn(async function* (_req: TurnRequest) {
    callCount++
    if (callCount === 1) return toolUseResult()
    return textResult('Done.')
  })
  const provider: ChatProvider = { id: 'bedrock-converse', sanitizeHistory: m => m, streamTurn, once: jest.fn() }
  mockGetProvider.mockReturnValue(provider)

  mockExecuteTool.mockImplementation(async (_name, _input, ctx) => {
    ctx.onProgress?.('Searching: something')
    return { entries: [{ kind: 'text', text: 'result' }], isError: false }
  })

  const chunks = []
  for await (const c of converseStream(
    DEFAULT_CHAT_MODEL,
    'system',
    [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
    { settings: { researchDepth: 'deep' }, ctx: { sub: 'u1', chatId: 'c1' }, call: TEST_CALL },
  )) {
    chunks.push(c)
  }

  const progressChunk = chunks.find(c => c.type === 'sub_agent_progress')
  expect(progressChunk).toEqual({ type: 'sub_agent_progress', toolUseId: 'call-1', name: 'web_search', text: 'Searching: something' })
})
