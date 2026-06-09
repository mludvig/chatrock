/**
 * Tests for the Increment 1.5 rework of chatStore:
 * - StreamingMsg now uses ordered steps[] + usage (not flat thinking/toolCalls)
 * - WS event sequence thinking→delta→tool_call_start→tool_call→tool_result→thinking→delta→usage→done
 *   should produce interleaved steps in arrival order.
 * - finalizeStream → a DisplayBubble with the same steps.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { act } from 'react'
import { useChatStore } from './chatStore'

// Reset store state between tests
beforeEach(() => {
  act(() => {
    const store = useChatStore.getState()
    store.clearStream()
    store.setMessages([])
  })
})

describe('StreamingMsg steps assembly', () => {
  it('thinking_delta: creates a thinking step when none exists, appends text', () => {
    act(() => {
      const s = useChatStore.getState()
      s.startStream()
      s.appendThinkingDelta('part1')
      s.appendThinkingDelta(' part2')
    })
    const sm = useChatStore.getState().streamingMsg
    expect(sm).not.toBeNull()
    const steps = sm!.steps
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: 'thinking', text: 'part1 part2' })
  })

  it('delta: creates a text step when last step is not open text, appends text', () => {
    act(() => {
      const s = useChatStore.getState()
      s.startStream()
      s.appendDelta('Hello')
      s.appendDelta(' world')
    })
    const steps = useChatStore.getState().streamingMsg!.steps
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: 'text', text: 'Hello world' })
  })

  it('thinking_done closes the current thinking step (does not add a new step)', () => {
    act(() => {
      const s = useChatStore.getState()
      s.startStream()
      s.appendThinkingDelta('thought')
      s.markThinkingDone()
      s.appendDelta('answer')
    })
    const steps = useChatStore.getState().streamingMsg!.steps
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({ kind: 'thinking', text: 'thought' })
    expect(steps[1]).toMatchObject({ kind: 'text', text: 'answer' })
  })

  it('tool_call_start: pushes a tool step and closes any open text/thinking', () => {
    act(() => {
      const s = useChatStore.getState()
      s.startStream()
      s.appendThinkingDelta('I think')
      s.addToolCall({ toolUseId: 't1', name: 'web_search', input: '' })
    })
    const steps = useChatStore.getState().streamingMsg!.steps
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({ kind: 'thinking', text: 'I think' })
    expect(steps[1]).toMatchObject({ kind: 'tool', toolUseId: 't1', name: 'web_search' })
  })

  it('tool_call: sets input on the matching tool step', () => {
    act(() => {
      const s = useChatStore.getState()
      s.startStream()
      s.addToolCall({ toolUseId: 't1', name: 'web_search', input: '' })
      s.updateToolCallInput('t1', '{"query":"foo"}')
    })
    const toolStep = useChatStore.getState().streamingMsg!.steps[0] as Record<string, unknown>
    expect(toolStep.input).toBe('{"query":"foo"}')
  })

  it('tool_result: sets result/isError/searchResults on the matching tool step', () => {
    const searchJson = JSON.stringify({ results: [{ title: 'T', url: 'https://x.com', description: 'D' }] })
    act(() => {
      const s = useChatStore.getState()
      s.startStream()
      s.addToolCall({ toolUseId: 't1', name: 'web_search', input: '' })
      s.resolveToolCall('t1', searchJson, false)
    })
    const toolStep = useChatStore.getState().streamingMsg!.steps[0] as Record<string, unknown>
    expect(toolStep.result).toBe(searchJson)
    expect(toolStep.isError).toBe(false)
    expect(Array.isArray(toolStep.searchResults)).toBe(true)
  })

  it('interleaved sequence: think→tool→think→text produces 4 ordered steps', () => {
    act(() => {
      const s = useChatStore.getState()
      s.startStream()
      s.appendThinkingDelta('first thought')
      s.markThinkingDone()
      s.addToolCall({ toolUseId: 't1', name: 'web_search', input: '' })
      s.updateToolCallInput('t1', '{"query":"x"}')
      s.resolveToolCall('t1', 'res', false)
      s.appendThinkingDelta('second thought')
      s.markThinkingDone()
      s.appendDelta('final answer')
    })
    const steps = useChatStore.getState().streamingMsg!.steps
    expect(steps).toHaveLength(4)
    expect(steps[0]).toMatchObject({ kind: 'thinking', text: 'first thought' })
    expect(steps[1]).toMatchObject({ kind: 'tool', toolUseId: 't1' })
    expect(steps[2]).toMatchObject({ kind: 'thinking', text: 'second thought' })
    expect(steps[3]).toMatchObject({ kind: 'text', text: 'final answer' })
  })

  it('usage event sets streamingMsg.usage', () => {
    act(() => {
      const s = useChatStore.getState()
      s.startStream()
      s.appendDelta('hi')
      s.setStreamUsage({ inputTokens: 42, outputTokens: 7, cacheReadInputTokens: 30 })
    })
    const sm = useChatStore.getState().streamingMsg!
    expect(sm.usage).toMatchObject({ inputTokens: 42, outputTokens: 7, cacheReadInputTokens: 30 })
  })
})

describe('finalizeStream', () => {
  it('moves streamingMsg to messages as a DisplayBubble with the same steps', () => {
    act(() => {
      const s = useChatStore.getState()
      s.startStream()
      s.appendThinkingDelta('thought')
      s.markThinkingDone()
      s.appendDelta('answer')
      s.setStreamUsage({ inputTokens: 10, outputTokens: 5 })
      s.finalizeStream()
    })
    const { messages, streamingMsg } = useChatStore.getState()
    expect(streamingMsg).toBeNull()
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
