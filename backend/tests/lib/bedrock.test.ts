/**
 * Tests for the refactored converseStream / streamOneTurn in bedrock.ts.
 *
 * These tests mock bedrockClient.send with a fake async stream and verify:
 *  1. Verbatim block assembly: reasoning text + signature + text + toolUse →
 *     a `turn` chunk with the exact ContentBlock[] in arrival order.
 *  2. redactedContent is captured as Uint8Array (not dropped).
 *  3. metadata event → a `usage` chunk.
 *  4. Tool-result user turn yields its own `turn` chunk.
 *  5. cachePoint is appended to tools[] and system[] (and on prior messages).
 *  6. All existing UI chunks (thinking_delta, thinking_done, delta,
 *     tool_call_start, tool_call, tool_result, stop) still flow through.
 */
import { converseStream, bedrockClient } from '../../src/lib/bedrock'
import * as tools from '../../src/lib/tools'

// Mock the bedrockClient so we never hit AWS
jest.mock('@aws-sdk/client-bedrock-runtime', () => {
  const actual = jest.requireActual('@aws-sdk/client-bedrock-runtime')
  return {
    ...actual,
    BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
      send: jest.fn(),
    })),
  }
})

// Mock executeTool to avoid real HTTP calls
jest.mock('../../src/lib/tools', () => ({
  ...jest.requireActual('../../src/lib/tools'),
  executeTool: jest.fn(),
}))

const mockExecuteTool = tools.executeTool as jest.MockedFunction<typeof tools.executeTool>

beforeEach(() => {
  getMockSend().mockReset()
  mockExecuteTool.mockReset()
})

// Helper: get the mocked `send` function from the client
function getMockSend() {
  return (bedrockClient as unknown as { send: jest.Mock }).send
}

// Helper: build a minimal fake ConverseStream response that wraps an
// async iterable of raw stream events
function fakeStreamResponse(events: unknown[]) {
  return {
    stream: (async function* () {
      for (const ev of events) yield ev
    })(),
  }
}

// ── Test 1: reasoning text + signature + text + toolUse ──────────────────────

test('assembles verbatim turn chunk with reasoning text+signature, text, toolUse', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    // Block 0: reasoning (text then signature)
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'think ' } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'more' } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'SIG123' } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    // Block 1: text
    { contentBlockStart: { contentBlockIndex: 1, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'Hello ' } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'world' } } },
    { contentBlockStop: { contentBlockIndex: 1 } },
    // Block 2: toolUse
    { contentBlockStart: { contentBlockIndex: 2, start: { toolUse: { toolUseId: 'tu-1', name: 'web_search' } } } },
    { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: '{"query' } } } },
    { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: '":"foo"}' } } } },
    { contentBlockStop: { contentBlockIndex: 2 } },
    // Stop: tool_use so the loop tries to execute tools
    { messageStop: { stopReason: 'tool_use' } },
    // Usage metadata
    { metadata: { usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheWriteInputTokens: 5 } } },
  ]))

  // Second round: mock executeTool then a simple end_turn response
  mockExecuteTool.mockResolvedValueOnce({
    toolUseId: 'tu-1',
    content: [{ text: 'search result' }],
    status: 'success',
  })
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 200, outputTokens: 20 } } },
  ]))

  const chunks: unknown[] = []
  for await (const chunk of converseStream('test-model', '', [], {})) {
    chunks.push(chunk)
  }

  // Find the first `turn` chunk (assistant round 0)
  const turnChunks = chunks.filter((c: unknown) => (c as {type: string}).type === 'turn')
  expect(turnChunks.length).toBeGreaterThanOrEqual(2) // at least: assistant turn + tool-result user turn

  const assistantTurn = (turnChunks as Array<{type: string; role: string; content: unknown[]; turnIndex: number}>)
    .find(t => t.role === 'assistant' && t.turnIndex === 0)
  expect(assistantTurn).toBeDefined()
  const content = assistantTurn!.content as Array<Record<string, unknown>>

  // Block 0: reasoning with text concatenated + signature
  expect(content[0]).toMatchObject({
    reasoningContent: {
      reasoningText: {
        text: 'think more',
        signature: 'SIG123',
      },
    },
  })

  // Block 1: text
  expect(content[1]).toMatchObject({ text: 'Hello world' })

  // Block 2: toolUse with parsed input
  expect(content[2]).toMatchObject({
    toolUse: {
      toolUseId: 'tu-1',
      name: 'web_search',
      input: { query: 'foo' },
    },
  })
})

// ── Test 2: redactedContent is captured as Uint8Array ────────────────────────

test('captures redactedContent on a reasoning block', async () => {
  const redactedBytes = new Uint8Array([1, 2, 3, 4])
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: redactedBytes } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { contentBlockStart: { contentBlockIndex: 1, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 1 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  const chunks: unknown[] = []
  for await (const chunk of converseStream('test-model', '', [], {})) {
    chunks.push(chunk)
  }

  const assistantTurn = (chunks as Array<{type: string; role: string; content: unknown[]}>)
    .find(c => (c as {type: string}).type === 'turn' && (c as {role: string}).role === 'assistant')
  expect(assistantTurn).toBeDefined()
  const block0 = (assistantTurn!.content as Array<Record<string, unknown>>)[0]
  expect(block0).toMatchObject({
    reasoningContent: { redactedContent: redactedBytes },
  })

  // UI: a redacted thinking block emits thinking_done but no thinking_delta text
  const thinkingDone = chunks.find(c => (c as {type: string}).type === 'thinking_done')
  expect(thinkingDone).toBeDefined()
})

// ── Test 3: metadata event → usage chunk ─────────────────────────────────────

test('emits a usage chunk from the metadata event', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'hi' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 42, outputTokens: 7, cacheReadInputTokens: 30 } } },
  ]))

  const chunks: unknown[] = []
  for await (const chunk of converseStream('test-model', '', [], {})) {
    chunks.push(chunk)
  }

  const usageChunk = chunks.find(c => (c as {type: string}).type === 'usage') as
    { type: string; usage: Record<string, number> } | undefined
  expect(usageChunk).toBeDefined()
  expect(usageChunk!.usage).toMatchObject({ inputTokens: 42, outputTokens: 7, cacheReadInputTokens: 30 })
})

// ── Test 4: tool-result user turn yields its own `turn` chunk ────────────────

test('yields a user turn chunk for tool results', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tu-2', name: 'web_fetch' } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"url":"https://x.com"}' } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'tool_use' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 3 } } },
  ]))
  mockExecuteTool.mockResolvedValueOnce({
    toolUseId: 'tu-2',
    content: [{ text: 'fetched content' }],
    status: 'success',
  })
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Done' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 20, outputTokens: 5 } } },
  ]))

  const chunks: unknown[] = []
  for await (const chunk of converseStream('test-model', '', [], {})) {
    chunks.push(chunk)
  }

  const userTurn = (chunks as Array<{type: string; role: string; content: unknown[]}>)
    .find(c => (c as {type: string}).type === 'turn' && (c as {role: string}).role === 'user')
  expect(userTurn).toBeDefined()
  const userContent = userTurn!.content as Array<Record<string, unknown>>
  expect(userContent[0]).toMatchObject({
    toolResult: {
      toolUseId: 'tu-2',
      content: [{ text: 'fetched content' }],
    },
  })
})

// ── Test 6: contentBlockStart may not fire before contentBlockDelta for text ──
//
// Defensive: if Bedrock skips contentBlockStart for a plain text block (seen in
// practice), the delta handler must create the block accumulator on the fly so
// the text ends up in the persisted `turn` chunk's content[].

test('handles missing contentBlockStart for a text block (creates acc on-the-fly)', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    // No contentBlockStart for block 0 — delta arrives cold
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello ' } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'world' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 5, outputTokens: 3 } } },
  ]))

  const chunks: unknown[] = []
  for await (const chunk of converseStream('test-model', '', [], {})) {
    chunks.push(chunk)
  }

  // UI chunks must still flow
  const deltaTexts = chunks
    .filter(c => (c as { type: string }).type === 'delta')
    .map(c => (c as { type: string; text: string }).text)
  expect(deltaTexts.join('')).toBe('Hello world')

  // The assistant turn chunk must contain the text (not empty blocks[])
  const assistantTurn = (chunks as Array<{ type: string; role: string; content: unknown[] }>)
    .find(c => (c as { type: string }).type === 'turn' && (c as { role: string }).role === 'assistant')
  expect(assistantTurn).toBeDefined()
  const content = assistantTurn!.content as Array<Record<string, unknown>>
  expect(content).toHaveLength(1)
  expect(content[0]).toMatchObject({ text: 'Hello world' })
})

// ── Test 7: forced final answer after max tool-use rounds ────────────────────
//
// When the model keeps returning tool_use without ever producing a text answer,
// converseStream should exhaust the tool-use loop and then do ONE more call
// with no tools (forced answer), ensuring a text response always follows.

test('after max tool-use rounds, does one final forced-answer call with no tools', async () => {
  const MAX = 8 // must match the constant in bedrock.ts

  // Mock MAX rounds of pure tool_use responses
  for (let i = 0; i < MAX; i++) {
    getMockSend().mockResolvedValueOnce(fakeStreamResponse([
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: `tu-${i}`, name: 'web_search' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"query":"x"}' } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'tool_use' } },
      { metadata: { usage: { inputTokens: 10, outputTokens: 2 } } },
    ]))
    mockExecuteTool.mockResolvedValueOnce({
      toolUseId: `tu-${i}`,
      content: [{ text: 'result' }],
      status: 'success',
    })
  }

  // Forced-answer round: returns text (no more tool_use)
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Final forced answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 50, outputTokens: 10 } } },
  ]))

  const chunks: unknown[] = []
  for await (const chunk of converseStream('test-model', '', [], {})) {
    chunks.push(chunk)
  }

  // Verify the forced-answer text delta made it through
  const deltaChunks = chunks.filter(c => (c as { type: string }).type === 'delta')
  expect(deltaChunks.length).toBeGreaterThan(0)
  const text = deltaChunks.map(c => (c as { text: string }).text).join('')
  expect(text).toBe('Final forced answer')

  // The stop reason should reflect the forced answer, not max_rounds
  const stopChunk = chunks.find(c => (c as { type: string }).type === 'stop') as
    { type: string; stopReason: string } | undefined
  expect(stopChunk).toBeDefined()
  expect(stopChunk!.stopReason).toBe('end_turn')

  // send() should have been called MAX + 1 times (MAX tool rounds + 1 forced answer)
  expect(getMockSend()).toHaveBeenCalledTimes(MAX + 1)
})

// ── F2: webSearch:false passes no toolConfig to Bedrock ──────────────────────

test('f2: webSearch:false, memoryEnabled:false sends no toolConfig in the Bedrock request', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  const chunks: unknown[] = []
  for await (const chunk of converseStream('test-model', '', [], { webSearch: false, memoryEnabled: false }, undefined, undefined)) {
    chunks.push(chunk)
  }

  // Bedrock send() was called once; the command input must have no toolConfig
  const cmdInput = getMockSend().mock.calls[0][0].input as Record<string, unknown>
  expect(cmdInput.toolConfig).toBeUndefined()
})

test('f2: webSearch:true (default) sends toolConfig to Bedrock', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  const chunks: unknown[] = []
  for await (const chunk of converseStream('test-model', '', [], {})) {
    chunks.push(chunk)
  }

  // Default (webSearch not set) should include toolConfig
  const cmdInput = getMockSend().mock.calls[0][0].input as Record<string, unknown>
  expect(cmdInput.toolConfig).toBeDefined()
})

// ── Memory tool assembly tests ────────────────────────────────────────────────

test('tools: webSearch:false, memoryEnabled:true → manage_memory tool present, web tools absent', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of converseStream('test-model', '', [], { webSearch: false, memoryEnabled: true }, undefined, undefined)) {
    // drain
  }

  const cmdInput = getMockSend().mock.calls[0][0].input as Record<string, unknown>
  expect(cmdInput.toolConfig).toBeDefined()
  const toolNames = ((cmdInput.toolConfig as { tools: Array<{ toolSpec?: { name: string } }> }).tools ?? [])
    .map(t => t.toolSpec?.name)
    .filter(Boolean)
  expect(toolNames).toContain('manage_memory')
  expect(toolNames).not.toContain('web_search')
  expect(toolNames).not.toContain('web_fetch')
})

test('tools: webSearch:true, memoryEnabled:true → both web tools AND memory tool present', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk2 of converseStream('test-model', '', [], { webSearch: true, memoryEnabled: true }, undefined, undefined)) {
    // drain
  }

  const cmdInput = getMockSend().mock.calls[0][0].input as Record<string, unknown>
  expect(cmdInput.toolConfig).toBeDefined()
  const toolNames = ((cmdInput.toolConfig as { tools: Array<{ toolSpec?: { name: string } }> }).tools ?? [])
    .map(t => t.toolSpec?.name)
    .filter(Boolean)
  expect(toolNames).toContain('manage_memory')
  expect(toolNames).toContain('web_search')
  expect(toolNames).toContain('web_fetch')
})

// ── ctx threading and memoryChanged chunk tests ───────────────────────────────

test('ctx: loop threads ctx into executeTool call — 3rd arg is {sub}', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tu-ctx', name: 'manage_memory' } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"operation":"remember","text":"I am a dev","category":"identity"}' } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'tool_use' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 3 } } },
  ]))
  mockExecuteTool.mockResolvedValueOnce({
    toolUseId: 'tu-ctx',
    content: [{ text: 'Saved.' }],
    status: 'success',
  })
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Done' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 20, outputTokens: 5 } } },
  ]))

  const toolCtx = { sub: 'user-from-ctx' }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk3 of converseStream('test-model', '', [], {}, toolCtx, undefined)) {
    // drain
  }

  // executeTool must have been called with ctx as 3rd argument
  expect(mockExecuteTool).toHaveBeenCalledTimes(1)
  const [, , ctxArg] = mockExecuteTool.mock.calls[0]
  expect(ctxArg).toEqual(toolCtx)
})

test('memoryChanged: manage_memory tool success → memoryChanged chunk yielded', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tu-mem', name: 'manage_memory' } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"operation":"remember","text":"I like Python","category":"preference"}' } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'tool_use' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 3 } } },
  ]))
  mockExecuteTool.mockResolvedValueOnce({
    toolUseId: 'tu-mem',
    content: [{ text: 'Saved.' }],
    status: 'success',
  })
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Done' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 20, outputTokens: 5 } } },
  ]))

  const chunks: unknown[] = []
  for await (const chunk of converseStream('test-model', '', [], {}, { sub: 'user-1' }, undefined)) {
    chunks.push(chunk)
  }

  const memChunk = chunks.find(c => (c as { type: string }).type === 'memoryChanged')
  expect(memChunk).toBeDefined()
})

test('memoryChanged NOT yielded when manage_memory returns error', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tu-fail', name: 'manage_memory' } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"operation":"forget"}' } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'tool_use' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 3 } } },
  ]))
  mockExecuteTool.mockResolvedValueOnce({
    toolUseId: 'tu-fail',
    content: [{ text: 'memId is required.' }],
    status: 'error',
  })
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Done' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 20, outputTokens: 5 } } },
  ]))

  const chunks: unknown[] = []
  for await (const chunk of converseStream('test-model', '', [], {}, { sub: 'user-1' }, undefined)) {
    chunks.push(chunk)
  }

  const memChunk = chunks.find(c => (c as { type: string }).type === 'memoryChanged')
  expect(memChunk).toBeUndefined()
})

// ── Part 1 fix: toolConfig present on the forced-final call after MAX rounds ──
//
// Before the fix, the forced-final call passed tools=[] which stripped toolConfig
// while the message history contained toolUse/toolResult blocks → ValidationException.
// After the fix, the final call must include a non-empty toolConfig.

test('part1a: forced-final call after max rounds has non-empty toolConfig in its Bedrock request', async () => {
  const MAX = 8

  for (let i = 0; i < MAX; i++) {
    getMockSend().mockResolvedValueOnce(fakeStreamResponse([
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: `tu-${i}`, name: 'web_search' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"query":"x"}' } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'tool_use' } },
      { metadata: { usage: { inputTokens: 10, outputTokens: 2 } } },
    ]))
    mockExecuteTool.mockResolvedValueOnce({ toolUseId: `tu-${i}`, content: [{ text: 'result' }], status: 'success' })
  }
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Final answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 50, outputTokens: 10 } } },
  ]))

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of converseStream('test-model', '', [], {})) { /* drain */ }

  // The final (MAX+1-th) send call must have toolConfig defined with real tools
  const finalCallInput = getMockSend().mock.calls[MAX][0].input as Record<string, unknown>
  const tc = finalCallInput.toolConfig as { tools: Array<{ toolSpec?: unknown }> } | undefined
  expect(tc).toBeDefined()
  expect(tc!.tools.filter(t => t.toolSpec).length).toBeGreaterThan(0)
})

// ── Part 1 fix: toolConfig required when disabled-tools but history has tool blocks ──
//
// If webSearch and memory are both off but the replayed history already contains
// toolUse/toolResult blocks, the first round still needs a toolConfig or Bedrock
// throws ValidationException.

test('part1b: history with toolResult blocks forces toolConfig even when webSearch+memory disabled', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  // Prior history that contains a toolResult block (as would be replayed from a chat
  // that used tools but whose current settings have tools disabled)
  const historyWithToolBlock = [
    {
      role: 'user' as const,
      content: [{ toolResult: { toolUseId: 'old-tu', content: [{ text: 'old result' }], status: 'success' as const } }],
    },
  ]

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of converseStream(
    'test-model', '', historyWithToolBlock, { webSearch: false, memoryEnabled: false },
  )) { /* drain */ }

  // toolConfig MUST be defined (history forces it)
  const cmdInput = getMockSend().mock.calls[0][0].input as Record<string, unknown>
  expect(cmdInput.toolConfig).toBeDefined()
  const tools = (cmdInput.toolConfig as { tools: Array<{ toolSpec?: unknown }> }).tools
  expect(tools.filter(t => t.toolSpec).length).toBeGreaterThan(0)
})

// ── Confirm non-regression: clean history + tools disabled still sends no toolConfig ──

test('part1c: clean history with webSearch+memory disabled still sends no toolConfig', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of converseStream(
    'test-model', '', [], { webSearch: false, memoryEnabled: false },
  )) { /* drain */ }

  // No tool blocks in history → no toolConfig needed (same as before)
  const cmdInput = getMockSend().mock.calls[0][0].input as Record<string, unknown>
  expect(cmdInput.toolConfig).toBeUndefined()
})

// ── Test 5: existing UI chunks still flow through ────────────────────────────

test('still emits thinking_delta, thinking_done, delta, tool_call_start, tool_call, tool_result, stop', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'ponder' } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'S' } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'tu-3', name: 'web_search' } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"query":"x"}' } } } },
    { contentBlockStop: { contentBlockIndex: 1 } },
    { messageStop: { stopReason: 'tool_use' } },
    { metadata: { usage: { inputTokens: 5, outputTokens: 2 } } },
  ]))
  mockExecuteTool.mockResolvedValueOnce({
    toolUseId: 'tu-3',
    content: [{ text: 'r' }],
    status: 'success',
  })
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'ok' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 15, outputTokens: 3 } } },
  ]))

  const types: string[] = []
  for await (const chunk of converseStream('test-model', '', [], {})) {
    types.push((chunk as {type: string}).type)
  }

  expect(types).toContain('thinking_delta')
  expect(types).toContain('thinking_done')
  expect(types).toContain('tool_call_start')
  expect(types).toContain('tool_call')
  expect(types).toContain('tool_result')
  expect(types).toContain('delta')
  expect(types).toContain('stop')
  expect(types).toContain('turn')
  expect(types).toContain('usage')
})

// ── project memory tool inclusion via ctx ─────────────────────────────────────

test('project memory: manage_project_memory tool included when ctx.projectId set and memoryEnabled not false', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of converseStream('test-model', '', [], {}, { sub: 'user-1', projectId: 'proj-abc' }, undefined)) {
    // drain
  }

  const cmdInput = getMockSend().mock.calls[0][0].input as Record<string, unknown>
  expect(cmdInput.toolConfig).toBeDefined()
  const toolNames = ((cmdInput.toolConfig as { tools: Array<{ toolSpec?: { name: string } }> }).tools ?? [])
    .map(t => t.toolSpec?.name)
    .filter(Boolean)
  expect(toolNames).toContain('manage_project_memory')
  expect(toolNames).toContain('manage_memory')
})

test('project memory: manage_project_memory tool excluded when no ctx.projectId', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of converseStream('test-model', '', [], {}, { sub: 'user-1' }, undefined)) {
    // drain
  }

  const cmdInput = getMockSend().mock.calls[0][0].input as Record<string, unknown>
  const toolNames = ((cmdInput.toolConfig as { tools: Array<{ toolSpec?: { name: string } }> } | undefined)?.tools ?? [])
    .map(t => t.toolSpec?.name)
    .filter(Boolean)
  expect(toolNames).not.toContain('manage_project_memory')
})

test('project memory: CACHE_POINT_TOOL always last in tool list when project memory present', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of converseStream('test-model', '', [], {}, { sub: 'user-1', projectId: 'proj-abc' }, undefined)) {
    // drain
  }

  const cmdInput = getMockSend().mock.calls[0][0].input as Record<string, unknown>
  const toolList = (cmdInput.toolConfig as { tools: Array<{ toolSpec?: { name: string }; cachePoint?: unknown }> }).tools
  // Last element must be the cachePoint tool (no toolSpec)
  const lastTool = toolList[toolList.length - 1]
  expect(lastTool.toolSpec).toBeUndefined()
  expect(lastTool.cachePoint).toBeDefined()
})

// ── read_project_file and read_project_chat tool inclusion ───────────────────

test('read tools: read_project_file and read_project_chat included when ctx.projectId set', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of converseStream('test-model', '', [], {}, { sub: 'user-1', projectId: 'proj-abc' }, undefined)) {
    // drain
  }

  const cmdInput = getMockSend().mock.calls[0][0].input as Record<string, unknown>
  expect(cmdInput.toolConfig).toBeDefined()
  const toolNames = ((cmdInput.toolConfig as { tools: Array<{ toolSpec?: { name: string } }> }).tools ?? [])
    .map(t => t.toolSpec?.name)
    .filter(Boolean)
  expect(toolNames).toContain('read_project_file')
  expect(toolNames).toContain('read_project_chat')
})

test('read tools: read_project_file and read_project_chat excluded when no ctx.projectId', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of converseStream('test-model', '', [], {}, { sub: 'user-1' }, undefined)) {
    // drain
  }

  const cmdInput = getMockSend().mock.calls[0][0].input as Record<string, unknown>
  const toolNames = ((cmdInput.toolConfig as { tools: Array<{ toolSpec?: { name: string } }> } | undefined)?.tools ?? [])
    .map(t => t.toolSpec?.name)
    .filter(Boolean)
  expect(toolNames).not.toContain('read_project_file')
  expect(toolNames).not.toContain('read_project_chat')
})

test('read tools: cachePoint is always last when read tools present', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of converseStream('test-model', '', [], {}, { sub: 'user-1', projectId: 'proj-abc' }, undefined)) {
    // drain
  }

  const cmdInput = getMockSend().mock.calls[0][0].input as Record<string, unknown>
  const toolList = (cmdInput.toolConfig as { tools: Array<{ toolSpec?: { name: string }; cachePoint?: unknown }> }).tools
  // Last element must be the cachePoint tool (no toolSpec)
  const lastTool = toolList[toolList.length - 1]
  expect(lastTool.toolSpec).toBeUndefined()
  expect(lastTool.cachePoint).toBeDefined()
})
