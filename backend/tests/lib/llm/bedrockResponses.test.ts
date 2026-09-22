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
const { bedrockResponsesProvider } = require('../../../src/lib/llm/providers/bedrockResponses')

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

describe('bedrockResponses.streamTurn', () => {
  test('basic text streaming builds correct StreamChunks and TurnResult', async () => {
    const response = {
      status: 'completed',
      output_text: 'Hello from GPT',
      output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello from GPT', annotations: [] }] }],
      usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 5, output_tokens_details: {}, total_tokens: 25 },
    }
    mockCreate.mockResolvedValue(fakeStream([
      { type: 'response.output_text.delta', delta: 'Hello ' },
      { type: 'response.output_text.delta', delta: 'from GPT' },
      { type: 'response.completed', response },
    ]))

    const gen = bedrockResponsesProvider.streamTurn({
      modelId: 'global.openai.gpt-5.6-terra',
      systemPrompt: 'be helpful',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
      tools: [],
      settings: {},
      cacheBoundaryIndex: -1,
    })
    const { chunks, result } = await drain(gen)

    expect(chunks).toEqual([
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'from GPT' },
    ])
    expect(result).toMatchObject({
      stopReason: 'end_turn',
      textContent: 'Hello from GPT',
      toolUses: [],
      content: [{ kind: 'text', text: 'Hello from GPT' }],
      usage: { inputTokens: 20, outputTokens: 5 },
    })

    // instructions/store:false/stream:true are always sent
    const params = mockCreate.mock.calls[0][0]
    expect(params.model).toBe('global.openai.gpt-5.6-terra')
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

    const gen = bedrockResponsesProvider.streamTurn({
      modelId: 'global.openai.gpt-5.6-terra',
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

    // replayContent carries the full (uncapped) opaque for this invocation's next round
    expect(result.replayContent[0]).toMatchObject({ kind: 'thinking', text: '7*8=56' })
    expect(result.replayContent[0].opaque).toBeDefined()
  })

  test('an oversized reasoning opaque is dropped from the persisted content but kept in replayContent', async () => {
    const hugeEncrypted = 'x'.repeat(200_000) // base64 chars; encoded opaque well over the 96 KB cap
    const response = {
      status: 'completed',
      output_text: 'done',
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'deep thought' }], encrypted_content: hugeEncrypted },
        { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] },
      ],
      usage: undefined,
    }
    mockCreate.mockResolvedValue(fakeStream([{ type: 'response.completed', response }]))

    const { result } = await drain(bedrockResponsesProvider.streamTurn({
      modelId: 'global.openai.gpt-5.6-terra', systemPrompt: '', messages: [], tools: [], settings: { thinkingEffort: 'max' }, cacheBoundaryIndex: -1,
    }))

    expect(result.content[0]).toEqual({ kind: 'thinking', text: 'deep thought' })
    expect(result.content[0].opaque).toBeUndefined()
    expect(result.replayContent[0].opaque).toBeDefined()
  })

  test('thinkingEffort:off is sent as effort none', async () => {
    mockCreate.mockResolvedValue(fakeStream([
      { type: 'response.completed', response: { status: 'completed', output_text: 'ok', output: [], usage: undefined } },
    ]))
    await drain(bedrockResponsesProvider.streamTurn({
      modelId: 'global.moonshotai.kimi-k3', systemPrompt: '', messages: [], tools: [], settings: { thinkingEffort: 'off' }, cacheBoundaryIndex: -1,
    }))
    const params = mockCreate.mock.calls[0][0]
    expect(params.reasoning).toEqual({ effort: 'none' })
    expect(params.include).toBeUndefined()
  })

  test('reasoning_text deltas (Kimi K3) stream as thinking and persist from the item content', async () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], content: [{ type: 'reasoning_text', text: 'think' }] }
    const response = {
      status: 'completed', output_text: 'hi',
      output: [reasoning, { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hi', annotations: [] }] }],
      usage: undefined,
    }
    mockCreate.mockResolvedValue(fakeStream([
      { type: 'response.reasoning_text.delta', delta: 'thi' },
      { type: 'response.reasoning_text.delta', delta: 'nk' },
      { type: 'response.output_item.done', item: reasoning },
      { type: 'response.output_text.delta', delta: 'hi' },
      { type: 'response.completed', response },
    ]))
    const { chunks, result } = await drain(bedrockResponsesProvider.streamTurn({
      modelId: 'global.moonshotai.kimi-k3', systemPrompt: '', messages: [], tools: [], settings: { thinkingEffort: 'low' }, cacheBoundaryIndex: -1,
    }))
    expect(chunks).toEqual([
      { type: 'thinking_delta', text: 'thi' },
      { type: 'thinking_delta', text: 'nk' },
      { type: 'thinking_done' },
      { type: 'delta', text: 'hi' },
    ])
    expect(result.content[0]).toMatchObject({ kind: 'thinking', text: 'think' })
  })

  test('function_call output produces tool_call_start/tool_call chunks and a tool_use stopReason', async () => {
    const fcItem = { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'web_search', arguments: '{"query":"x"}', status: 'completed' }
    const response = { status: 'completed', output_text: '', output: [fcItem], usage: undefined }
    mockCreate.mockResolvedValue(fakeStream([
      { type: 'response.output_item.added', item: fcItem },
      { type: 'response.output_item.done', item: fcItem },
      { type: 'response.completed', response },
    ]))

    const gen = bedrockResponsesProvider.streamTurn({
      modelId: 'global.openai.gpt-5.6-terra',
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
    await drain(bedrockResponsesProvider.streamTurn({
      modelId: 'global.openai.gpt-5.6-terra',
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
    const { result } = await drain(bedrockResponsesProvider.streamTurn({
      modelId: 'global.openai.gpt-5.6-terra', systemPrompt: '', messages: [], tools: [], settings: {}, cacheBoundaryIndex: -1,
    }))
    expect(result.stopReason).toBe('max_tokens')
  })

  describe('encrypted reasoning the API cannot decrypt', () => {
    const response = { status: 'completed', output_text: 'ok', output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }], usage: undefined }
    const opaque = encodeOpaque('bedrock-responses', { id: 'rs_1', encryptedContent: 'ENC', model: 'global.openai.gpt-6-sol' })
    const messages: NeutralMessage[] = [
      { role: 'user', content: [{ kind: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ kind: 'thinking', text: 'thought', opaque }, { kind: 'text', text: 'a1' }] },
      { role: 'user', content: [{ kind: 'text', text: 'q2' }] },
    ]
    const turn = () => bedrockResponsesProvider.streamTurn({
      modelId: 'global.openai.gpt-6-sol', systemPrompt: '', messages, tools: [], settings: { thinkingEffort: 'low' }, cacheBoundaryIndex: -1,
    })
    const hasReasoning = (input: Array<{ type?: string }>) => input.some(i => i.type === 'reasoning')

    test.each([
      '400 Encrypted content cannot be used in a different region from the one that created it.',
      '400 encrypted reasoning was created for a different model',
    ])('retries once without reasoning items when the API rejects it: %s', async (message) => {
      mockCreate
        .mockRejectedValueOnce(Object.assign(new Error(message), { status: 400 }))
        .mockResolvedValueOnce(fakeStream([{ type: 'response.completed', response }]))

      const { result } = await drain(turn())

      expect(result.textContent).toBe('ok')
      expect(mockCreate).toHaveBeenCalledTimes(2)
      expect(hasReasoning(mockCreate.mock.calls[0][0].input)).toBe(true)
      expect(hasReasoning(mockCreate.mock.calls[1][0].input)).toBe(false)
    })

    test('does not retry any other 400', async () => {
      mockCreate.mockRejectedValueOnce(Object.assign(new Error('400 Invalid input'), { status: 400 }))
      await expect(drain(turn())).rejects.toThrow('400 Invalid input')
      expect(mockCreate).toHaveBeenCalledTimes(1)
    })
  })
})

describe('bedrockResponses.sanitizeHistory', () => {
  test('drops thinking blocks with foreign (bedrock-converse) opaque', () => {
    const opaque = encodeOpaque('bedrock-converse', { signature: 'sig' })
    const messages: NeutralMessage[] = [
      { role: 'assistant', content: [{ kind: 'thinking', text: 'claude thought', opaque }, { kind: 'text', text: 'answer' }] },
    ]
    const sanitized = bedrockResponsesProvider.sanitizeHistory(messages)
    expect(sanitized).toEqual([{ role: 'assistant', content: [{ kind: 'text', text: 'answer' }] }])
  })

  test('coalesces two consecutive user turns', () => {
    const messages: NeutralMessage[] = [
      { role: 'user', content: [{ kind: 'text', text: 'Q' }] },
      { role: 'user', content: [{ kind: 'text', text: 'continue' }] },
    ]
    const sanitized = bedrockResponsesProvider.sanitizeHistory(messages)
    expect(sanitized).toEqual([{ role: 'user', content: [{ kind: 'text', text: 'Q' }, { kind: 'text', text: 'continue' }] }])
  })

  test('heals a dangling tail tool_call with a synthetic error tool_result', () => {
    const messages: NeutralMessage[] = [
      { role: 'user', content: [{ kind: 'text', text: 'Q' }] },
      { role: 'assistant', content: [{ kind: 'tool_call', callId: 'call_1', name: 'web_search', input: {} }] },
    ]
    const sanitized = bedrockResponsesProvider.sanitizeHistory(messages)
    expect(sanitized).toHaveLength(3)
    expect(sanitized[2]).toEqual({
      role: 'user',
      content: [{ kind: 'tool_result', callId: 'call_1', entries: [{ kind: 'text', text: expect.any(String) }], isError: true }],
    })
  })

  test('is a no-op for a well-formed alternating history with our own thinking blocks', () => {
    const opaque = encodeOpaque('bedrock-responses', { id: 'rs_1' })
    const messages: NeutralMessage[] = [
      { role: 'user', content: [{ kind: 'text', text: 'Q' }] },
      { role: 'assistant', content: [{ kind: 'thinking', text: 'plan', opaque }, { kind: 'text', text: 'A' }] },
    ]
    expect(bedrockResponsesProvider.sanitizeHistory(messages)).toEqual(messages)
  })
})

describe('bedrockResponses.once', () => {
  test('returns trimmed output_text, sends store:false', async () => {
    mockCreate.mockResolvedValue({ output_text: '  Paris  ' })
    const result = await bedrockResponsesProvider.once({
      modelId: 'global.openai.gpt-5.6-terra',
      systemPrompt: 'Answer concisely.',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'capital of France?' }] }],
      maxTokens: 32,
    })
    expect(result.text).toBe('Paris')
    const params = mockCreate.mock.calls[0][0]
    expect(params.store).toBe(false)
    expect(params.max_output_tokens).toBe(32)
    expect(params.stream).toBeUndefined()
  })
})

describe('bedrockResponses client', () => {
  test('targets the bedrock-runtime endpoint in the backend region', async () => {
    mockCreate.mockResolvedValue({ output_text: 'ok' })
    await bedrockResponsesProvider.once({
      modelId: 'global.openai.gpt-5.6-terra', systemPrompt: '',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
    })
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { bedrock } = require('openai/providers/bedrock/aws')
    expect(bedrock).toHaveBeenCalledTimes(1)
    expect(bedrock.mock.calls[0][0]).toEqual(expect.objectContaining({ endpoint: 'runtime', region: 'ap-southeast-2' }))
  })
})
