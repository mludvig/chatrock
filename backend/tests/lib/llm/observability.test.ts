/**
 * The `llm_call` record is emitted by the wrapper (lib/llm/loop.ts), not by call sites —
 * see docs/adr/0029-llm-observability-in-the-wrapper.md. These tests pin that contract:
 * exactly one record per invocation, on every exit path (normal stop, abort, error, an
 * early break by the consumer), with the invocation's summed token usage and the caller's
 * own label.
 */
import type { ChatProvider, StreamChunk, TurnResult } from '../../../src/lib/llm/types'
import * as tools from '../../../src/lib/tools'

// A stub provider so these tests exercise loop.ts's shell, not any real wire format: each
// round shifts one prepared TurnResult off the queue.
let stubResults: TurnResult[] = []
let stubThrow: Error | undefined
let stubOnce: { text: string; usage?: { inputTokens: number; outputTokens: number } } = { text: '' }

const stubProvider: ChatProvider = {
  id: 'bedrock-converse',
  sanitizeHistory: m => m,
  async *streamTurn(): AsyncGenerator<StreamChunk, TurnResult> {
    yield { type: 'delta', text: 'a' }
    if (stubThrow) throw stubThrow
    return stubResults.shift() ?? textResult()
  },
  once: async () => stubOnce,
}

function textResult(usage?: TurnResult['usage']): TurnResult {
  return { stopReason: 'end_turn', textContent: 'hi', toolUses: [], content: [{ kind: 'text', text: 'hi' }], usage }
}

jest.mock('../../../src/lib/llm/registry', () => ({ getProvider: () => stubProvider }))

import { converseStream, converseOnce } from '../../../src/lib/llm/loop'

const MODEL = 'global.anthropic.claude-sonnet-5'
const CALL = { purpose: 'chat' as const, sub: 'user-1', chatId: 'c1' }

let logSpy: jest.SpyInstance
let errorSpy: jest.SpyInstance

beforeEach(() => {
  stubResults = []
  stubThrow = undefined
  stubOnce = { text: '' }
  jest.spyOn(tools, 'executeTool').mockResolvedValue({
    entries: [{ kind: 'text', text: 'tool output' }], isError: false,
  })
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
  logSpy.mockRestore()
  errorSpy.mockRestore()
})

function records(spy: jest.SpyInstance): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map(args => { try { return JSON.parse(args[0] as string) as Record<string, unknown> } catch { return null } })
    .filter((o): o is Record<string, unknown> => o?.event === 'llm_call')
}

test('a completed stream emits one llm_call with the label, stopReason and usage', async () => {
  stubResults = [textResult({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3 })]

  for await (const chunk of converseStream(MODEL, '', [], { call: CALL })) { void chunk }

  const recs = records(logSpy)
  expect(recs).toHaveLength(1)
  expect(recs[0]).toMatchObject({
    event: 'llm_call', purpose: 'chat', sub: 'user-1', chatId: 'c1',
    model: MODEL, provider: 'bedrock-converse', ok: true,
    stopReason: 'end_turn', rounds: 1,
    inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3,
  })
  expect(typeof recs[0].durationMs).toBe('number')
  // A provider that reports no cache-write counter must not appear to have reported 0.
  expect(recs[0]).not.toHaveProperty('cacheWriteInputTokens')
})

test('usage is summed across the invocation, not just the last round', async () => {
  stubResults = [
    { stopReason: 'tool_use', textContent: '', content: [{ kind: 'text', text: '' }],
      toolUses: [{ callId: 't1', name: 'web_search', inputJson: '{}' }],
      usage: { inputTokens: 10, outputTokens: 5, cacheWriteInputTokens: 2 } },
    textResult({ inputTokens: 7, outputTokens: 3, cacheWriteInputTokens: 1 }),
  ]

  for await (const chunk of converseStream(MODEL, '', [], { call: CALL })) { void chunk }

  expect(records(logSpy)[0]).toMatchObject({
    rounds: 2, inputTokens: 17, outputTokens: 8, cacheWriteInputTokens: 3,
  })
})

test('a consumer that breaks out of the for-await still gets exactly one record', async () => {
  stubResults = [textResult({ inputTokens: 10, outputTokens: 5 })]

  for await (const chunk of converseStream(MODEL, '', [], { call: CALL })) {
    if (chunk.type === 'usage') break
  }

  const recs = records(logSpy)
  expect(recs).toHaveLength(1)
  expect(recs[0]).toMatchObject({ ok: true, inputTokens: 10 })
  expect(recs[0].stopReason).toBeUndefined()
})

test('an already-aborted call is labelled stopReason=aborted', async () => {
  const ctrl = new AbortController()
  ctrl.abort()

  for await (const chunk of converseStream(MODEL, '', [], { call: CALL, abortSignal: ctrl.signal })) { void chunk }

  expect(records(logSpy)[0]).toMatchObject({ ok: true, stopReason: 'aborted', rounds: 0 })
})

test('a thrown error emits ok:false on console.error and rethrows', async () => {
  stubThrow = new Error('provider exploded')

  await expect((async () => {
    for await (const chunk of converseStream(MODEL, '', [], { call: CALL })) { void chunk }
  })()).rejects.toThrow('provider exploded')

  expect(records(logSpy)).toEqual([])
  expect(records(errorSpy)[0]).toMatchObject({ ok: false, error: 'Error: provider exploded' })
})

test('converseOnce logs its own record and returns just the text', async () => {
  stubOnce = { text: 'Paris', usage: { inputTokens: 4, outputTokens: 1 } }

  const text = await converseOnce(MODEL, 'sys', [], { maxTokens: 32, call: { purpose: 'chat_title', chatId: 'c1' } })

  expect(text).toBe('Paris')
  expect(records(logSpy)[0]).toMatchObject({
    purpose: 'chat_title', chatId: 'c1', ok: true, rounds: 1, inputTokens: 4, outputTokens: 1,
  })
})

test('converseOnce logs ok:false and rethrows when the provider fails', async () => {
  stubProvider.once = async () => { throw new Error('nope') }

  await expect(converseOnce(MODEL, '', [], { call: { purpose: 'chat_summary' } })).rejects.toThrow('nope')
  expect(records(errorSpy)[0]).toMatchObject({ purpose: 'chat_summary', ok: false, error: 'Error: nope' })

  stubProvider.once = async () => stubOnce
})
