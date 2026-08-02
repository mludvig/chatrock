// Cross-provider correctness: the mid-chat switching requirement from the plan.
// Both providers' sanitizeHistory must drop the OTHER provider's opaque thinking
// material (never replay a foreign signature/encrypted_content — that's a hard
// failure on Converse and meaningless on Mantle) while leaving everything else
// — visible text, tool call ids — untouched and unrewritten.
import { bedrockConverseProvider } from '../../../src/lib/llm/providers/bedrockConverse'
import { bedrockMantleProvider } from '../../../src/lib/llm/providers/bedrockMantle'
import { encodeOpaque, type NeutralMessage } from '../../../src/lib/llm/blocks'

// A history that could only arise from a chat that started on Claude, called a
// tool, switched to GPT mid-conversation, and is about to be replayed to either
// provider again — the shape both sanitizeHistory implementations must handle.
function mixedProviderHistory(): NeutralMessage[] {
  const claudeOpaque = encodeOpaque('bedrock-converse', { signature: 'CLAUDE_SIG' })
  const mantleOpaque = encodeOpaque('bedrock-mantle', { id: 'rs_1', encryptedContent: 'GPT_ENC' })
  return [
    { role: 'user', content: [{ kind: 'text', text: 'search for x' }] },
    { role: 'assistant', content: [
      { kind: 'thinking', text: 'claude reasoning', opaque: claudeOpaque },
      { kind: 'tool_call', callId: 'tooluse_abc123', name: 'web_search', input: { query: 'x' } },
    ] },
    { role: 'user', content: [{ kind: 'tool_result', callId: 'tooluse_abc123', entries: [{ kind: 'text', text: 'result' }], isError: false }] },
    { role: 'assistant', content: [
      { kind: 'thinking', text: 'gpt reasoning', opaque: mantleOpaque },
      { kind: 'text', text: 'here is the answer' },
    ] },
  ]
}

describe('cross-provider sanitizeHistory symmetry', () => {
  test('Converse keeps its own thinking block, drops the Mantle one, keeps text and tool call ids unrewritten', () => {
    const sanitized = bedrockConverseProvider.sanitizeHistory(mixedProviderHistory())
    const allBlocks = sanitized.flatMap(m => m.content)

    const thinkingBlocks = allBlocks.filter(b => b.kind === 'thinking')
    expect(thinkingBlocks).toHaveLength(1)
    expect(thinkingBlocks[0]).toMatchObject({ text: 'claude reasoning' })
    expect((thinkingBlocks[0] as Extract<typeof thinkingBlocks[0], { kind: 'thinking' }>).opaque?.provider).toBe('bedrock-converse')

    // Tool call id round-trips verbatim — never rewritten between providers
    const toolCall = allBlocks.find(b => b.kind === 'tool_call')
    const toolResult = allBlocks.find(b => b.kind === 'tool_result')
    expect(toolCall).toMatchObject({ callId: 'tooluse_abc123' })
    expect(toolResult).toMatchObject({ callId: 'tooluse_abc123' })

    // GPT's visible answer text survives even though its thinking is stripped
    expect(allBlocks.some(b => b.kind === 'text' && b.text === 'here is the answer')).toBe(true)
  })

  test('Mantle keeps its own thinking block, drops the Converse one, keeps text and tool call ids unrewritten', () => {
    const sanitized = bedrockMantleProvider.sanitizeHistory(mixedProviderHistory())
    const allBlocks = sanitized.flatMap(m => m.content)

    const thinkingBlocks = allBlocks.filter(b => b.kind === 'thinking')
    expect(thinkingBlocks).toHaveLength(1)
    expect(thinkingBlocks[0]).toMatchObject({ text: 'gpt reasoning' })
    expect((thinkingBlocks[0] as Extract<typeof thinkingBlocks[0], { kind: 'thinking' }>).opaque?.provider).toBe('bedrock-mantle')

    const toolCall = allBlocks.find(b => b.kind === 'tool_call')
    const toolResult = allBlocks.find(b => b.kind === 'tool_result')
    expect(toolCall).toMatchObject({ callId: 'tooluse_abc123' })
    expect(toolResult).toMatchObject({ callId: 'tooluse_abc123' })

    expect(allBlocks.some(b => b.kind === 'text' && b.text === 'here is the answer')).toBe(true)
  })

  test('neither provider ever emits an opaque key when translating back out (Converse)', () => {
    const sanitized = bedrockConverseProvider.sanitizeHistory(mixedProviderHistory())
    const serialized = JSON.stringify(sanitized)
    expect(serialized).not.toContain('CLAUDE_SIG')
    expect(serialized).not.toContain('GPT_ENC')
    // opaque IS present in the neutral form (it's the at-rest field) — this asserts
    // the SECRET payloads never leak as plaintext substrings, not that opaque is absent.
  })

  test('a history with only foreign opaque (no same-provider material at all) sanitizes without throwing, for both providers', () => {
    const onlyMantle: NeutralMessage[] = [
      { role: 'assistant', content: [{ kind: 'thinking', text: 'gpt', opaque: encodeOpaque('bedrock-mantle', { id: 'rs_1' }) }] },
      { role: 'assistant', content: [{ kind: 'text', text: 'answer' }] },
    ]
    expect(() => bedrockConverseProvider.sanitizeHistory(onlyMantle)).not.toThrow()
    expect(bedrockConverseProvider.sanitizeHistory(onlyMantle).flatMap(m => m.content).some(b => b.kind === 'thinking')).toBe(false)

    const onlyConverse: NeutralMessage[] = [
      { role: 'assistant', content: [{ kind: 'thinking', text: 'claude', opaque: encodeOpaque('bedrock-converse', { signature: 'sig' }) }] },
      { role: 'assistant', content: [{ kind: 'text', text: 'answer' }] },
    ]
    expect(() => bedrockMantleProvider.sanitizeHistory(onlyConverse)).not.toThrow()
    expect(bedrockMantleProvider.sanitizeHistory(onlyConverse).flatMap(m => m.content).some(b => b.kind === 'thinking')).toBe(false)
  })
})
