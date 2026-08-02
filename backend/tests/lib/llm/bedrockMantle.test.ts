// Mocks the openai SDK client (responses.create -> a fake async generator of SSE-shaped
// events), not raw HTTP/SSE bytes — the SDK already parses SSE into typed events, so the
// fake is structurally the same trick tests/lib/bedrock.test.ts uses for Converse events.
import { encodeOpaque, type NeutralMessage } from '../../../src/lib/llm/blocks'

const mockCreate = jest.fn()

jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({ responses: { create: mockCreate } })),
}))
jest.mock('openai/providers/bedrock/aws', () => ({
  bedrock: jest.fn((opts: unknown) => opts),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { bedrockMantleProvider } = require('../../../src/lib/llm/providers/bedrockMantle')

async function* fakeStream(events: unknown[]) {
  for (const e of events) yield e
}

async function drain(gen: AsyncGenerator<unknown, unknown>) {
  const chunks: unknown[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any
  while (true) {
    const { value, done } = await gen.next()
    if (done) { result = value; break }
    chunks.push(value)
  }
  return { chunks, result }
}

beforeEach(() => {
  mockCreate.mockReset()
})

describe('bedrockMantle.streamTurn', () => {
  test('basic text streaming builds correct StreamChunks and TurnResult', async () => {
    const response = {
      status: 'completed',
      output_text: 'Hello from Mantle',
      output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello from Mantle', annotations: [] }] }],
      usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 5, output_tokens_details: {}, total_tokens: 25 },
    }
    mockCreate.mockResolvedValue(fakeStream([
      { type: 'response.output_text.delta', delta: 'Hello ' },
      { type: 'response.output_text.delta', delta: 'from Mantle' },
      { type: 'response.completed', response },
    ]))

    const gen = bedrockMantleProvider.streamTurn({
      modelId: 'openai.gpt-5.6-terra',
      systemPrompt: 'be helpful',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
      tools: [],
      settings: {},
      cacheBoundaryIndex: -1,
    })
    const { chunks, result } = await drain(gen)

    expect(chunks).toEqual([
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'from Mantle' },
    ])
    expect(result).toMatchObject({
      stopReason: 'end_turn',
      textContent: 'Hello from Mantle',
      toolUses: [],
      content: [{ kind: 'text', text: 'Hello from Mantle' }],
      usage: { inputTokens: 20, outputTokens: 5 },
    })

    // instructions/store:false/stream:true are always sent
    const params = mockCreate.mock.calls[0][0]
    expect(params.model).toBe('openai.gpt-5.6-terra')
    expect(params.instructions).toBe('be helpful')
    expect(params.store).toBe(false)
    expect(params.stream).toBe(true)
  })

  test('reasoning summary deltas become thinking_delta/thinking_done, and usage subtracts cached tokens', async () => {
    const response = {
      status: 'completed',
      output_text: '56',
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '7*8=56' }], encrypted_content: 'ENC' },
        { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '56', annotations: [] }] },
      ],
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 }, output_tokens: 10, output_tokens_details: {}, total_tokens: 110 },
    }
    mockCreate.mockResolvedValue(fakeStream([
      { type: 'response.reasoning_summary_text.delta', delta: '7*8' },
      { type: 'response.reasoning_summary_text.delta', delta: '=56' },
      { type: 'response.output_item.done', item: response.output[0] },
      { type: 'response.output_text.delta', delta: '56' },
      { type: 'response.completed', response },
    ]))

    const gen = bedrockMantleProvider.streamTurn({
      modelId: 'openai.gpt-5.6-terra',
      systemPrompt: '',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'What is 7*8?' }] }],
      tools: [],
      settings: { thinkingEffort: 'low' },
      cacheBoundaryIndex: -1,
    })
    const { chunks, result } = await drain(gen)

    expect(chunks).toEqual([
      { type: 'thinking_delta', text: '7*8' },
      { type: 'thinking_delta', text: '=56' },
      { type: 'thinking_done' },
      { type: 'delta', text: '56' },
    ])
    expect(result.usage).toEqual({ inputTokens: 60, outputTokens: 10, cacheReadInputTokens: 40 })
    expect(result.content[0]).toMatchObject({ kind: 'thinking', text: '7*8=56' })

    const params = mockCreate.mock.calls[0][0]
    expect(params.reasoning).toEqual({ effort: 'low', summary: 'auto' })
    expect(params.include).toEqual(['reasoning.encrypted_content'])
  })

  test('thinkingEffort:off omits reasoning params entirely', async () => {
    mockCreate.mockResolvedValue(fakeStream([
      { type: 'response.completed', response: { status: 'completed', output_text: 'ok', output: [], usage: undefined } },
    ]))
    await drain(bedrockMantleProvider.streamTurn({
      modelId: 'openai.gpt-5.6-terra', systemPrompt: '', messages: [], tools: [], settings: { thinkingEffort: 'off' }, cacheBoundaryIndex: -1,
    }))
    const params = mockCreate.mock.calls[0][0]
    expect(params.reasoning).toBeUndefined()
    expect(params.include).toBeUndefined()
  })

  test('function_call output produces tool_call_start/tool_call chunks and a tool_use stopReason', async () => {
    const fcItem = { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'web_search', arguments: '{"query":"x"}', status: 'completed' }
    const response = { status: 'completed', output_text: '', output: [fcItem], usage: undefined }
    mockCreate.mockResolvedValue(fakeStream([
      { type: 'response.output_item.added', item: fcItem },
      { type: 'response.output_item.done', item: fcItem },
      { type: 'response.completed', response },
    ]))

    const gen = bedrockMantleProvider.streamTurn({
      modelId: 'openai.gpt-5.6-terra',
      systemPrompt: '',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'search for x' }] }],
      tools: [{ name: 'web_search', description: 'search', inputSchema: { type: 'object', properties: {} } }],
      settings: {},
      cacheBoundaryIndex: -1,
    })
    const { chunks, result } = await drain(gen)

    expect(chunks).toEqual([
      { type: 'tool_call_start', toolUseId: 'call_abc', name: 'web_search' },
      { type: 'tool_call', toolUseId: 'call_abc', name: 'web_search', input: '{"query":"x"}' },
    ])
    expect(result.stopReason).toBe('tool_use')
    expect(result.toolUses).toEqual([{ callId: 'call_abc', name: 'web_search', inputJson: '{"query":"x"}' }])

    const params = mockCreate.mock.calls[0][0]
    expect(params.tools).toEqual([{ type: 'function', name: 'web_search', description: 'search', parameters: { type: 'object', properties: {} }, strict: false }])
  })

  test('forceToolName sets tool_choice to that function', async () => {
    mockCreate.mockResolvedValue(fakeStream([
      { type: 'response.completed', response: { status: 'completed', output_text: '', output: [], usage: undefined } },
    ]))
    await drain(bedrockMantleProvider.streamTurn({
      modelId: 'openai.gpt-5.6-terra',
      systemPrompt: '',
      messages: [],
      tools: [{ name: 'search_history', description: 'x', inputSchema: {} }],
      settings: {},
      cacheBoundaryIndex: -1,
      forceToolName: 'search_history',
    }))
    const params = mockCreate.mock.calls[0][0]
    expect(params.tool_choice).toEqual({ type: 'function', name: 'search_history' })
  })

  test('response.incomplete maps to max_tokens stopReason', async () => {
    const response = { status: 'incomplete', output_text: 'partial', output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: 'partial', annotations: [] }] }], usage: undefined }
    mockCreate.mockResolvedValue(fakeStream([
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'response.incomplete', response },
    ]))
    const { result } = await drain(bedrockMantleProvider.streamTurn({
      modelId: 'openai.gpt-5.6-terra', systemPrompt: '', messages: [], tools: [], settings: {}, cacheBoundaryIndex: -1,
    }))
    expect(result.stopReason).toBe('max_tokens')
  })
})

describe('bedrockMantle.sanitizeHistory', () => {
  test('drops thinking blocks with foreign (bedrock-converse) opaque', () => {
    const opaque = encodeOpaque('bedrock-converse', { signature: 'sig' })
    const messages: NeutralMessage[] = [
      { role: 'assistant', content: [{ kind: 'thinking', text: 'claude thought', opaque }, { kind: 'text', text: 'answer' }] },
    ]
    const sanitized = bedrockMantleProvider.sanitizeHistory(messages)
    expect(sanitized).toEqual([{ role: 'assistant', content: [{ kind: 'text', text: 'answer' }] }])
  })

  test('coalesces two consecutive user turns', () => {
    const messages: NeutralMessage[] = [
      { role: 'user', content: [{ kind: 'text', text: 'Q' }] },
      { role: 'user', content: [{ kind: 'text', text: 'continue' }] },
    ]
    const sanitized = bedrockMantleProvider.sanitizeHistory(messages)
    expect(sanitized).toEqual([{ role: 'user', content: [{ kind: 'text', text: 'Q' }, { kind: 'text', text: 'continue' }] }])
  })

  test('heals a dangling tail tool_call with a synthetic error tool_result', () => {
    const messages: NeutralMessage[] = [
      { role: 'user', content: [{ kind: 'text', text: 'Q' }] },
      { role: 'assistant', content: [{ kind: 'tool_call', callId: 'call_1', name: 'web_search', input: {} }] },
    ]
    const sanitized = bedrockMantleProvider.sanitizeHistory(messages)
    expect(sanitized).toHaveLength(3)
    expect(sanitized[2]).toEqual({
      role: 'user',
      content: [{ kind: 'tool_result', callId: 'call_1', entries: [{ kind: 'text', text: expect.any(String) }], isError: true }],
    })
  })

  test('is a no-op for a well-formed alternating history with our own thinking blocks', () => {
    const opaque = encodeOpaque('bedrock-mantle', { id: 'rs_1' })
    const messages: NeutralMessage[] = [
      { role: 'user', content: [{ kind: 'text', text: 'Q' }] },
      { role: 'assistant', content: [{ kind: 'thinking', text: 'plan', opaque }, { kind: 'text', text: 'A' }] },
    ]
    expect(bedrockMantleProvider.sanitizeHistory(messages)).toEqual(messages)
  })
})

describe('bedrockMantle.once', () => {
  test('returns trimmed output_text, sends store:false', async () => {
    mockCreate.mockResolvedValue({ output_text: '  Paris  ' })
    const text = await bedrockMantleProvider.once({
      modelId: 'openai.gpt-5.6-terra',
      systemPrompt: 'Answer concisely.',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'capital of France?' }] }],
      maxTokens: 32,
    })
    expect(text).toBe('Paris')
    const params = mockCreate.mock.calls[0][0]
    expect(params.store).toBe(false)
    expect(params.max_output_tokens).toBe(32)
    expect(params.stream).toBeUndefined()
  })
})
