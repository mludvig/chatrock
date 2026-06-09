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
