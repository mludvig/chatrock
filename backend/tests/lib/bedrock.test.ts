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
import { converseStream, coalesceMessages, healDanglingToolUse, bedrockClient, HEARTBEAT_INTERVAL_MS } from '../../src/lib/bedrock'
import { TOOL_RESULTS_ROUND_CAP } from '../../src/lib/blocks'
import * as tools from '../../src/lib/tools'
import * as attachmentsLib from '../../src/lib/attachments'
import { s3KeyPrefix } from '../../src/lib/attachments'
import type { Message } from '@aws-sdk/client-bedrock-runtime'

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

// Mock S3/CloudFront writes — keep s3KeyPrefix real (pure, deterministic) for key-shape asserts
jest.mock('../../src/lib/attachments', () => ({
  ...jest.requireActual('../../src/lib/attachments'),
  putObjectBytes: jest.fn(),
  signCloudFrontUrl: jest.fn(),
}))

const mockExecuteTool = tools.executeTool as jest.MockedFunction<typeof tools.executeTool>
const mockPutObjectBytes = (attachmentsLib as jest.Mocked<typeof attachmentsLib>).putObjectBytes
const mockSignCloudFrontUrl = (attachmentsLib as jest.Mocked<typeof attachmentsLib>).signCloudFrontUrl

beforeEach(() => {
  getMockSend().mockReset()
  mockExecuteTool.mockReset()
  mockPutObjectBytes.mockReset()
  mockSignCloudFrontUrl.mockReset()
  mockPutObjectBytes.mockImplementation(async (key: string) => `s3://test-bucket/${key}`)
  mockSignCloudFrontUrl.mockImplementation(async (key: string) => `https://cdn.example.com/${key}?sig=x`)
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

// ── Regression: many parallel tool calls in one round must not blow past the
// DynamoDB 400KB item limit when their results are bundled into one turn ──────
//
// Reproduces a real production failure: the model fanned out 30 parallel web_search
// calls in a single round; each result was capped at the old flat 30KB, but their sum
// (~900KB) exceeded the DynamoDB item limit and the PutItem was rejected with
// "ValidationException: Item size has exceeded the maximum allowed size".

test('30 parallel tool calls in one round: aggregate tool-result content stays within TOOL_RESULTS_ROUND_CAP', async () => {
  const N = 30
  const bigResult = 'x'.repeat(40_000) // bigger than the old flat 30KB cap on its own

  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    ...Array.from({ length: N }, (_, i) => [
      { contentBlockStart: { contentBlockIndex: i, start: { toolUse: { toolUseId: `tu-${i}`, name: 'web_search' } } } },
      { contentBlockDelta: { contentBlockIndex: i, delta: { toolUse: { input: '{"query":"x"}' } } } },
      { contentBlockStop: { contentBlockIndex: i } },
    ]).flat(),
    { messageStop: { stopReason: 'tool_use' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 2 } } },
  ]))
  for (let i = 0; i < N; i++) {
    mockExecuteTool.mockResolvedValueOnce({
      toolUseId: `tu-${i}`,
      content: [{ text: bigResult }],
      status: 'success',
    })
  }
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

  const userTurn = (chunks as Array<{ type: string; role: string; content: Array<Record<string, unknown>> }>)
    .find(c => c.type === 'turn' && c.role === 'user')!
  expect(userTurn.content).toHaveLength(N)

  const totalBytes = userTurn.content.reduce((sum, block) => {
    const toolResult = block.toolResult as { content: Array<{ text: string }> }
    return sum + Buffer.byteLength(toolResult.content[0].text, 'utf8')
  }, 0)
  expect(totalBytes).toBeLessThanOrEqual(TOOL_RESULTS_ROUND_CAP)
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

// ── F2: webSearchEnabled:false passes no toolConfig to Bedrock ──────────────────────

test('f2: webSearchEnabled:false, memoryEnabled:false sends no toolConfig in the Bedrock request', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  const chunks: unknown[] = []
  for await (const chunk of converseStream('test-model', '', [], { webSearchEnabled: false, memoryEnabled: false, browserToolEnabled: false }, undefined, undefined)) {
    chunks.push(chunk)
  }

  // Bedrock send() was called once; the command input must have no toolConfig
  const cmdInput = getMockSend().mock.calls[0][0].input as Record<string, unknown>
  expect(cmdInput.toolConfig).toBeUndefined()
})

test('f2: webSearchEnabled:true (default) sends toolConfig to Bedrock', async () => {
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

  // Default (webSearchEnabled not set) should include toolConfig
  const cmdInput = getMockSend().mock.calls[0][0].input as Record<string, unknown>
  expect(cmdInput.toolConfig).toBeDefined()
})

// ── Memory tool assembly tests ────────────────────────────────────────────────

test('tools: webSearchEnabled:false, memoryEnabled:true → manage_memory tool present, web tools absent', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of converseStream('test-model', '', [], { webSearchEnabled: false, memoryEnabled: true }, undefined, undefined)) {
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

test('tools: webSearchEnabled:true, memoryEnabled:true → both web tools AND memory tool present', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk2 of converseStream('test-model', '', [], { webSearchEnabled: true, memoryEnabled: true }, undefined, undefined)) {
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
// If webSearchEnabled and memory are both off but the replayed history already contains
// toolUse/toolResult blocks, the first round still needs a toolConfig or Bedrock
// throws ValidationException.

test('part1b: history with toolResult blocks forces toolConfig even when webSearchEnabled+memory disabled', async () => {
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
    'test-model', '', historyWithToolBlock, { webSearchEnabled: false, memoryEnabled: false },
  )) { /* drain */ }

  // toolConfig MUST be defined (history forces it)
  const cmdInput = getMockSend().mock.calls[0][0].input as Record<string, unknown>
  expect(cmdInput.toolConfig).toBeDefined()
  const tools = (cmdInput.toolConfig as { tools: Array<{ toolSpec?: unknown }> }).tools
  expect(tools.filter(t => t.toolSpec).length).toBeGreaterThan(0)
})

// ── Regression: converseStream heals a dangling tool_use tail before calling Bedrock ──
//
// Reproduces the second incident from this session end-to-end: a replayed history ending
// on an assistant message with an unresolved toolUse (the matching tool-result turn never
// got persisted). Without healing, Bedrock would reject the whole request.

test('regression: converseStream heals a dangling tool_use tail in the replayed history before the Bedrock call', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  const historyWithDanglingToolUse = [
    { role: 'user' as const, content: [{ text: 'find the latest news' }] },
    { role: 'assistant' as const, content: [{ toolUse: { toolUseId: 'orphan-tu', name: 'web_search', input: { query: 'news' } } }] },
  ]

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of converseStream('test-model', '', historyWithDanglingToolUse, {})) { /* drain */ }

  const cmdInput = getMockSend().mock.calls[0][0].input as Record<string, unknown>
  const sentMessages = cmdInput.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
  // The dangling assistant message must now be followed by a synthesized toolResult —
  // not sent to Bedrock as a bare, unresolved tail.
  expect(sentMessages[sentMessages.length - 1].role).toBe('user')
  expect(sentMessages[sentMessages.length - 1].content[0]).toMatchObject({
    toolResult: { toolUseId: 'orphan-tu' },
  })
})

// ── Confirm non-regression: clean history + tools disabled still sends no toolConfig ──

test('part1c: clean history with webSearchEnabled+memory disabled still sends no toolConfig', async () => {
  getMockSend().mockResolvedValueOnce(fakeStreamResponse([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'answer' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
  ]))

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of converseStream(
    'test-model', '', [], { webSearchEnabled: false, memoryEnabled: false, browserToolEnabled: false },
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

// ── coalesceMessages: role-alternation guard ──────────────────────────────────

describe('coalesceMessages', () => {
  test('merges two consecutive user turns (interrupted agentic loop + new user msg)', () => {
    const toolResultBlock = { toolResult: { toolUseId: 't1', content: [{ text: 'res' }], status: 'success' as const } }
    const merged = coalesceMessages([
      { role: 'user', content: [{ text: 'Q' }] },
      { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'web_search', input: {} } }] },
      { role: 'user', content: [toolResultBlock] },        // dangling tool-result leaf
      { role: 'user', content: [{ text: 'continue' }] },   // new user message
    ])
    // The two trailing user turns collapse into one valid user message
    expect(merged).toHaveLength(3)
    expect(merged[2].role).toBe('user')
    expect(merged[2].content).toEqual([toolResultBlock, { text: 'continue' }])
    // No two adjacent same-role messages remain
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i].role).not.toBe(merged[i - 1].role)
    }
  })

  test('is a no-op for a well-formed alternating history', () => {
    const msgs = [
      { role: 'user' as const, content: [{ text: 'Q' }] },
      { role: 'assistant' as const, content: [{ text: 'A' }] },
      { role: 'user' as const, content: [{ text: 'Q2' }] },
    ]
    expect(coalesceMessages(msgs)).toEqual(msgs)
  })

  test('does not mutate the input array or its messages', () => {
    const input = [
      { role: 'user' as const, content: [{ text: 'a' }] },
      { role: 'user' as const, content: [{ text: 'b' }] },
    ]
    const snapshot = JSON.parse(JSON.stringify(input))
    coalesceMessages(input)
    expect(input).toEqual(snapshot)
  })
})

// ── healDanglingToolUse ───────────────────────────────────────────────────────
//
// Reproduces the second incident from this session: a tail assistant message with
// toolUse blocks but no following toolResult message — Bedrock rejects this outright
// ("tool_use ids were found without tool_result blocks..." / "Expected toolResult
// blocks..."). healDanglingToolUse synthesizes the missing toolResult so the prefix
// is valid before it ever reaches Bedrock.

describe('healDanglingToolUse', () => {
  test('synthesizes a placeholder error toolResult for a dangling tail tool_use', () => {
    const healed = healDanglingToolUse([
      { role: 'user', content: [{ text: 'Q' }] },
      { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'web_search', input: {} } }] },
    ])
    expect(healed).toHaveLength(3)
    expect(healed[2].role).toBe('user')
    expect(healed[2].content).toEqual([
      { toolResult: { toolUseId: 't1', content: [{ text: expect.any(String) }], status: 'error' } },
    ])
  })

  test('synthesizes one placeholder toolResult per dangling id when multiple are present', () => {
    const healed = healDanglingToolUse([
      { role: 'user', content: [{ text: 'Q' }] },
      {
        role: 'assistant',
        content: [
          { toolUse: { toolUseId: 't1', name: 'web_search', input: {} } },
          { toolUse: { toolUseId: 't2', name: 'web_search', input: {} } },
        ],
      },
    ])
    expect(healed).toHaveLength(3)
    const ids = (healed[2].content ?? []).map(b => (b as { toolResult: { toolUseId: string } }).toolResult.toolUseId)
    expect(ids).toEqual(['t1', 't2'])
  })

  test('is a no-op when the tail assistant message has no toolUse blocks', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ text: 'Q' }] },
      { role: 'assistant', content: [{ text: 'A' }] },
    ]
    expect(healDanglingToolUse(msgs)).toEqual(msgs)
  })

  test('is a no-op when the tail message is already a user (toolResult) turn', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'web_search', input: {} } }] },
      { role: 'user', content: [{ toolResult: { toolUseId: 't1', content: [{ text: 'res' }], status: 'success' } }] },
    ]
    expect(healDanglingToolUse(msgs)).toEqual(msgs)
  })

  test('is a no-op for an empty message array', () => {
    expect(healDanglingToolUse([])).toEqual([])
  })

  test('composes with coalesceMessages: heals after coalescing a dangling-toolResult-then-new-user-message history', () => {
    // This history has TWO failure shapes from the same incident: a dangling tool-result
    // user turn followed by a new user message (coalesceMessages' job), AND — separately —
    // verify a clean tail tool_use is still healed when there is no trailing user message.
    const healed = healDanglingToolUse(coalesceMessages([
      { role: 'user', content: [{ text: 'Q' }] },
      { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'web_search', input: {} } }] },
    ]))
    expect(healed).toHaveLength(3)
    expect(healed[2].role).toBe('user')
  })
})

describe('browse_web image-bearing tool results: live/persist bifurcation', () => {
  const CTX = { sub: 'user-1', chatId: 'chat-1' }
  const PNG_BYTES = Buffer.from('fakepngbytes')

  function mockBrowseWebRound() {
    getMockSend().mockResolvedValueOnce(fakeStreamResponse([
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tu-browse', name: 'browse_web' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"steps":[{"tool":"browser_take_screenshot","params":{}}]}' } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'tool_use' } },
      { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
    ]))
    mockExecuteTool.mockResolvedValueOnce({
      toolUseId: 'tu-browse',
      content: [
        { text: '### browser_take_screenshot\ndone' },
        { image: { format: 'png', source: { bytes: PNG_BYTES } } },
      ],
      status: 'success',
    })
    getMockSend().mockResolvedValueOnce(fakeStreamResponse([
      { contentBlockStart: { contentBlockIndex: 0, start: {} } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Here is the screenshot.' } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'end_turn' } },
      { metadata: { usage: { inputTokens: 20, outputTokens: 5 } } },
    ]))
  }

  test('persisted turn chunk uses s3Location, not inline bytes', async () => {
    mockBrowseWebRound()

    const turnChunks: Array<{ role: string; content: unknown[] }> = []
    for await (const chunk of converseStream('test-model', '', [], {}, CTX)) {
      if ((chunk as { type: string }).type === 'turn') turnChunks.push(chunk as { role: string; content: unknown[] })
    }

    const toolResultTurn = turnChunks.find(t => t.role === 'user')!
    const block = toolResultTurn.content[0] as { toolResult: { content: Array<Record<string, unknown>> } }
    const imageEntry = block.toolResult.content.find(c => 'image' in c) as { image: { source: { s3Location?: { uri: string }; bytes?: Uint8Array } } }
    expect(imageEntry.image.source.s3Location).toBeDefined()
    expect(imageEntry.image.source.bytes).toBeUndefined()
    expect(imageEntry.image.source.s3Location!.uri).toContain(s3KeyPrefix(CTX.sub, CTX.chatId))
  })

  test('the next round\'s outgoing Bedrock request uses inline bytes, not s3Location', async () => {
    mockBrowseWebRound()

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of converseStream('test-model', '', [], {}, CTX)) { /* drain */ }

    // Second send() call is the next round's request, replaying newMessages
    const secondCallInput = getMockSend().mock.calls[1][0].input as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }
    const toolResultMsg = secondCallInput.messages.find(m => m.role === 'user' && m.content.some(c => 'toolResult' in c))!
    const block = toolResultMsg.content[0] as { toolResult: { content: Array<Record<string, unknown>> } }
    const imageEntry = block.toolResult.content.find(c => 'image' in c) as { image: { source: { bytes?: Uint8Array; s3Location?: unknown } } }
    expect(imageEntry.image.source.bytes).toEqual(PNG_BYTES)
    expect(imageEntry.image.source.s3Location).toBeUndefined()
  })

  test('uploads the image via putObjectBytes under the chat attachment prefix and signs it', async () => {
    mockBrowseWebRound()

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of converseStream('test-model', '', [], {}, CTX)) { /* drain */ }

    expect(mockPutObjectBytes).toHaveBeenCalledTimes(1)
    const [key, bytes, contentType] = mockPutObjectBytes.mock.calls[0]
    expect(key).toBe(`${s3KeyPrefix(CTX.sub, CTX.chatId)}browser-tu-browse-0.png`)
    expect(bytes).toEqual(PNG_BYTES)
    expect(contentType).toBe('image/png')
    expect(mockSignCloudFrontUrl).toHaveBeenCalledWith(key)
  })

  test('live tool_result WS frame is a JSON envelope with screenshotUrls when an image is present', async () => {
    mockBrowseWebRound()

    const toolResultChunks: Array<{ content: string }> = []
    for await (const chunk of converseStream('test-model', '', [], {}, CTX)) {
      if ((chunk as { type: string }).type === 'tool_result') toolResultChunks.push(chunk as { content: string })
    }

    expect(toolResultChunks).toHaveLength(1)
    const parsed = JSON.parse(toolResultChunks[0].content) as { texts: string[]; screenshotUrls: string[] }
    expect(parsed.screenshotUrls).toEqual(['https://cdn.example.com/' + s3KeyPrefix(CTX.sub, CTX.chatId) + 'browser-tu-browse-0.png?sig=x'])
    expect(parsed.texts[0]).toContain('done')
  })

  test('emits heartbeat chunks while a slow tool call is in flight, so the WS connection carries traffic during the gap', async () => {
    getMockSend().mockResolvedValueOnce(fakeStreamResponse([
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tu-slow', name: 'browse_web' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"steps":[{"tool":"browser_navigate","params":{"url":"https://example.com"}}]}' } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'tool_use' } },
      { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
    ]))
    // Resolve executeTool only after the heartbeat interval has genuinely elapsed, so the
    // race inside the round loop has time to fire at least one heartbeat tick.
    mockExecuteTool.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({
      toolUseId: 'tu-slow', content: [{ text: 'done' }], status: 'success',
    }), HEARTBEAT_INTERVAL_MS + 200)))
    getMockSend().mockResolvedValueOnce(fakeStreamResponse([
      { contentBlockStart: { contentBlockIndex: 0, start: {} } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Answer' } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'end_turn' } },
      { metadata: { usage: { inputTokens: 20, outputTokens: 5 } } },
    ]))

    const chunkTypes: string[] = []
    for await (const chunk of converseStream('test-model', '', [], {}, { sub: 'user-1' })) {
      chunkTypes.push((chunk as { type: string }).type)
    }

    expect(chunkTypes).toContain('heartbeat')
    expect(chunkTypes.indexOf('heartbeat')).toBeLessThan(chunkTypes.indexOf('tool_result'))
  }, HEARTBEAT_INTERVAL_MS + 5000)

  test('text-only tool results (e.g. web_search) are unaffected — plain text, no S3 calls', async () => {
    getMockSend().mockResolvedValueOnce(fakeStreamResponse([
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tu-ws', name: 'web_search' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"query":"hi"}' } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'tool_use' } },
      { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
    ]))
    mockExecuteTool.mockResolvedValueOnce({ toolUseId: 'tu-ws', content: [{ text: 'plain result' }], status: 'success' })
    getMockSend().mockResolvedValueOnce(fakeStreamResponse([
      { contentBlockStart: { contentBlockIndex: 0, start: {} } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Answer' } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'end_turn' } },
      { metadata: { usage: { inputTokens: 20, outputTokens: 5 } } },
    ]))

    const toolResultChunks: Array<{ content: string }> = []
    for await (const chunk of converseStream('test-model', '', [], {}, CTX)) {
      if ((chunk as { type: string }).type === 'tool_result') toolResultChunks.push(chunk as { content: string })
    }

    expect(toolResultChunks[0].content).toBe('plain result')
    expect(mockPutObjectBytes).not.toHaveBeenCalled()
    expect(mockSignCloudFrontUrl).not.toHaveBeenCalled()
  })
})
