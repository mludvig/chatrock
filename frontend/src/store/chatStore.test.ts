/**
 * Tests for the Increment 1.5 rework of chatStore:
 * - StreamingMsg now uses ordered steps[] + usage (not flat thinking/toolCalls)
 * - WS event sequence thinking→delta→tool_call_start→tool_call→tool_result→thinking→delta→usage→done
 *   should produce interleaved steps in arrival order.
 * - finalizeStream → a DisplayBubble with the same steps.
 *
 * All streaming mutators are keyed by chatId (B3 — see
 * docs/adr/0040-concurrent-per-chat-streaming.md), so every test operates on one fixed
 * TEST_CHAT_ID and reads back via streamingByChat[TEST_CHAT_ID].
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { act } from 'react'
import { useChatStore } from './chatStore'
import type { Message } from '../api/http'

const TEST_CHAT_ID = 'chat1'

// Reset store state between tests
beforeEach(() => {
  act(() => {
    const store = useChatStore.getState()
    store.clearStream(TEST_CHAT_ID)
    store.setMessages([])
  })
})

describe('StreamingMsg steps assembly', () => {
  it('thinking_delta: creates a thinking step when none exists, appends text', () => {
    act(() => {
      const s = useChatStore.getState()
      s.startStream(TEST_CHAT_ID)
      s.appendThinkingDelta(TEST_CHAT_ID, 'part1')
      s.appendThinkingDelta(TEST_CHAT_ID, ' part2')
    })
    const sm = useChatStore.getState().streamingByChat[TEST_CHAT_ID]
    expect(sm).not.toBeUndefined()
    const steps = sm!.steps
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: 'thinking', text: 'part1 part2' })
  })

  it('delta: creates a text step when last step is not open text, appends text', () => {
    act(() => {
      const s = useChatStore.getState()
      s.startStream(TEST_CHAT_ID)
      s.appendDelta(TEST_CHAT_ID, 'Hello')
      s.appendDelta(TEST_CHAT_ID, ' world')
    })
    const steps = useChatStore.getState().streamingByChat[TEST_CHAT_ID]!.steps
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: 'text', text: 'Hello world' })
  })

  it('thinking_done closes the current thinking step (does not add a new step)', () => {
    act(() => {
      const s = useChatStore.getState()
      s.startStream(TEST_CHAT_ID)
      s.appendThinkingDelta(TEST_CHAT_ID, 'thought')
      s.markThinkingDone(TEST_CHAT_ID)
      s.appendDelta(TEST_CHAT_ID, 'answer')
    })
    const steps = useChatStore.getState().streamingByChat[TEST_CHAT_ID]!.steps
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({ kind: 'thinking', text: 'thought' })
    expect(steps[1]).toMatchObject({ kind: 'text', text: 'answer' })
  })

  it('tool_call_start: pushes a tool step and closes any open text/thinking', () => {
    act(() => {
      const s = useChatStore.getState()
      s.startStream(TEST_CHAT_ID)
      s.appendThinkingDelta(TEST_CHAT_ID, 'I think')
      s.addToolCall(TEST_CHAT_ID, { toolUseId: 't1', name: 'web_search', input: '' })
    })
    const steps = useChatStore.getState().streamingByChat[TEST_CHAT_ID]!.steps
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({ kind: 'thinking', text: 'I think' })
    expect(steps[1]).toMatchObject({ kind: 'tool', toolUseId: 't1', name: 'web_search' })
  })

  it('tool_call: sets input on the matching tool step', () => {
    act(() => {
      const s = useChatStore.getState()
      s.startStream(TEST_CHAT_ID)
      s.addToolCall(TEST_CHAT_ID, { toolUseId: 't1', name: 'web_search', input: '' })
      s.updateToolCallInput(TEST_CHAT_ID, 't1', '{"query":"foo"}')
    })
    const toolStep = useChatStore.getState().streamingByChat[TEST_CHAT_ID]!.steps[0] as Record<string, unknown>
    expect(toolStep.input).toBe('{"query":"foo"}')
  })

  it('tool_result: sets result/isError/searchResults on the matching tool step', () => {
    const searchJson = JSON.stringify({ results: [{ title: 'T', url: 'https://x.com', description: 'D' }] })
    act(() => {
      const s = useChatStore.getState()
      s.startStream(TEST_CHAT_ID)
      s.addToolCall(TEST_CHAT_ID, { toolUseId: 't1', name: 'web_search', input: '' })
      s.resolveToolCall(TEST_CHAT_ID, 't1', searchJson, false)
    })
    const toolStep = useChatStore.getState().streamingByChat[TEST_CHAT_ID]!.steps[0] as Record<string, unknown>
    expect(toolStep.result).toBe(searchJson)
    expect(toolStep.isError).toBe(false)
    expect(Array.isArray(toolStep.searchResults)).toBe(true)
  })

  it('tool_result: sets screenshotUrls directly from the WS frame field (no JSON re-parse)', () => {
    act(() => {
      const s = useChatStore.getState()
      s.startStream(TEST_CHAT_ID)
      s.addToolCall(TEST_CHAT_ID, { toolUseId: 't1', name: 'take_screenshot', input: '' })
      s.resolveToolCall(TEST_CHAT_ID, 't1', '### browser_take_screenshot\ndone', false, ['https://cdn.example.com/shot.png?sig=x'])
    })
    const toolStep = useChatStore.getState().streamingByChat[TEST_CHAT_ID]!.steps[0] as Record<string, unknown>
    expect(toolStep.result).toBe('### browser_take_screenshot\ndone')
    expect(toolStep.screenshotUrls).toEqual(['https://cdn.example.com/shot.png?sig=x'])
  })

  it('interleaved sequence: think→tool→think→text produces 4 ordered steps', () => {
    act(() => {
      const s = useChatStore.getState()
      s.startStream(TEST_CHAT_ID)
      s.appendThinkingDelta(TEST_CHAT_ID, 'first thought')
      s.markThinkingDone(TEST_CHAT_ID)
      s.addToolCall(TEST_CHAT_ID, { toolUseId: 't1', name: 'web_search', input: '' })
      s.updateToolCallInput(TEST_CHAT_ID, 't1', '{"query":"x"}')
      s.resolveToolCall(TEST_CHAT_ID, 't1', 'res', false)
      s.appendThinkingDelta(TEST_CHAT_ID, 'second thought')
      s.markThinkingDone(TEST_CHAT_ID)
      s.appendDelta(TEST_CHAT_ID, 'final answer')
    })
    const steps = useChatStore.getState().streamingByChat[TEST_CHAT_ID]!.steps
    expect(steps).toHaveLength(4)
    expect(steps[0]).toMatchObject({ kind: 'thinking', text: 'first thought' })
    expect(steps[1]).toMatchObject({ kind: 'tool', toolUseId: 't1' })
    expect(steps[2]).toMatchObject({ kind: 'thinking', text: 'second thought' })
    expect(steps[3]).toMatchObject({ kind: 'text', text: 'final answer' })
  })

  it('usage event sets streamingMsg.usage', () => {
    act(() => {
      const s = useChatStore.getState()
      s.startStream(TEST_CHAT_ID)
      s.appendDelta(TEST_CHAT_ID, 'hi')
      s.setStreamUsage(TEST_CHAT_ID, { inputTokens: 42, outputTokens: 7, cacheReadInputTokens: 30 })
    })
    const sm = useChatStore.getState().streamingByChat[TEST_CHAT_ID]!
    expect(sm.usage).toMatchObject({ inputTokens: 42, outputTokens: 7, cacheReadInputTokens: 30 })
  })
})

describe('finalizeStream', () => {
  it('moves streamingMsg to messages as a DisplayBubble with the same steps', () => {
    let finalized: Message | undefined
    act(() => {
      const s = useChatStore.getState()
      s.startStream(TEST_CHAT_ID)
      s.appendThinkingDelta(TEST_CHAT_ID, 'thought')
      s.markThinkingDone(TEST_CHAT_ID)
      s.appendDelta(TEST_CHAT_ID, 'answer')
      s.setStreamUsage(TEST_CHAT_ID, { inputTokens: 10, outputTokens: 5 })
      finalized = s.finalizeStream(TEST_CHAT_ID)
      if (finalized) s.setMessages([finalized])
    })
    const { messages, streamingByChat } = useChatStore.getState()
    expect(streamingByChat[TEST_CHAT_ID]).toBeUndefined()
    expect(messages).toHaveLength(1)
    const bubble = messages[0] as unknown as Record<string, unknown>
    expect(bubble.role).toBe('assistant')
    const steps = bubble.steps as Array<Record<string, unknown>>
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({ kind: 'thinking', text: 'thought' })
    expect(steps[1]).toMatchObject({ kind: 'text', text: 'answer' })
    expect(bubble.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  })
})
