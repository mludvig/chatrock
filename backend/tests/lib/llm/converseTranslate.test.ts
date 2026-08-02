import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime'
import { toNeutral, fromNeutral } from '../../../src/lib/llm/providers/converseTranslate'
import type { Block } from '../../../src/lib/llm/blocks'

describe('converseTranslate: toNeutral / fromNeutral round-trip', () => {
  test('text block', () => {
    const bedrock: ContentBlock[] = [{ text: 'hello world' }]
    const neutral = toNeutral(bedrock)
    expect(neutral).toEqual([{ kind: 'text', text: 'hello world' }])
    expect(fromNeutral(neutral)).toEqual(bedrock)
  })

  test('thinking block with signature', () => {
    const bedrock: ContentBlock[] = [{ reasoningContent: { reasoningText: { text: 'thinking...', signature: 'sig-abc' } } }]
    const neutral = toNeutral(bedrock)
    expect(neutral).toHaveLength(1)
    expect(neutral[0]).toMatchObject({ kind: 'thinking', text: 'thinking...' })
    expect((neutral[0] as Extract<Block, { kind: 'thinking' }>).opaque?.provider).toBe('bedrock-converse')
    expect(fromNeutral(neutral)).toEqual(bedrock)
  })

  test('redacted thinking block', () => {
    const redacted = Buffer.from('redacted-bytes')
    const bedrock: ContentBlock[] = [{ reasoningContent: { redactedContent: redacted } }]
    const neutral = toNeutral(bedrock)
    expect(neutral[0]).toMatchObject({ kind: 'thinking', text: '', redacted: true })
    const back = fromNeutral(neutral)
    expect((back[0] as { reasoningContent: { redactedContent: Uint8Array } }).reasoningContent.redactedContent).toEqual(redacted)
  })

  test('thinking block with foreign opaque is dropped on fromNeutral', () => {
    const neutral: Block[] = [{ kind: 'thinking', text: 'gpt reasoning', opaque: { provider: 'bedrock-mantle', v: 1, data: 'xxx' } }]
    expect(fromNeutral(neutral)).toEqual([])
  })

  test('thinking block with no opaque is dropped on fromNeutral', () => {
    const neutral: Block[] = [{ kind: 'thinking', text: 'no signature' }]
    expect(fromNeutral(neutral)).toEqual([])
  })

  test('tool_call block', () => {
    const bedrock: ContentBlock[] = [{ toolUse: { toolUseId: 'tooluse_1', name: 'web_search', input: { query: 'foo' } } }]
    const neutral = toNeutral(bedrock)
    expect(neutral).toEqual([{ kind: 'tool_call', callId: 'tooluse_1', name: 'web_search', input: { query: 'foo' } }])
    expect(fromNeutral(neutral)).toEqual(bedrock)
  })

  test('tool_result block, text only, success', () => {
    const bedrock: ContentBlock[] = [{ toolResult: { toolUseId: 'tooluse_1', content: [{ text: 'result text' }], status: 'success' } }]
    const neutral = toNeutral(bedrock)
    expect(neutral).toEqual([{ kind: 'tool_result', callId: 'tooluse_1', entries: [{ kind: 'text', text: 'result text' }], isError: false }])
    expect(fromNeutral(neutral)).toEqual(bedrock)
  })

  test('tool_result block, error status', () => {
    const bedrock: ContentBlock[] = [{ toolResult: { toolUseId: 'tooluse_1', content: [{ text: 'boom' }], status: 'error' } }]
    const neutral = toNeutral(bedrock)
    expect((neutral[0] as Extract<Block, { kind: 'tool_result' }>).isError).toBe(true)
    expect(fromNeutral(neutral)).toEqual(bedrock)
  })

  test('tool_result block with nested image entry (screenshot, s3Location)', () => {
    const bedrock: ContentBlock[] = [{
      toolResult: {
        toolUseId: 'tooluse_2',
        content: [{ text: 'here' }, { image: { format: 'png', source: { s3Location: { uri: 's3://bucket/key.png' } } } }],
        status: 'success',
      },
    }]
    const neutral = toNeutral(bedrock)
    expect(fromNeutral(neutral)).toEqual(bedrock)
  })

  test('image block (user attachment, s3Location)', () => {
    const bedrock: ContentBlock[] = [{ image: { format: 'jpeg', source: { s3Location: { uri: 's3://bucket/img.jpg' } } } }]
    const neutral = toNeutral(bedrock)
    expect(neutral).toEqual([{ kind: 'image', image: { format: 'jpeg', source: { s3Uri: 's3://bucket/img.jpg' } } }])
    expect(fromNeutral(neutral)).toEqual(bedrock)
  })

  test('image block with inline bytes', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const bedrock: ContentBlock[] = [{ image: { format: 'png', source: { bytes } } }]
    const neutral = toNeutral(bedrock)
    expect(fromNeutral(neutral)).toEqual(bedrock)
  })

  test('document block with citations enabled', () => {
    const bedrock: ContentBlock[] = [{
      document: { format: 'pdf', name: 'report', source: { s3Location: { uri: 's3://bucket/report.pdf' } }, citations: { enabled: true } },
    }]
    const neutral = toNeutral(bedrock)
    expect(neutral).toEqual([{ kind: 'document', document: { format: 'pdf', name: 'report', source: { s3Uri: 's3://bucket/report.pdf' }, citations: true } }])
    expect(fromNeutral(neutral)).toEqual(bedrock)
  })

  test('document block with citations disabled', () => {
    const bedrock: ContentBlock[] = [{
      document: { format: 'txt', name: 'notes', source: { s3Location: { uri: 's3://bucket/notes.txt' } }, citations: { enabled: false } },
    }]
    const neutral = toNeutral(bedrock)
    expect(fromNeutral(neutral)).toEqual(bedrock)
  })

  test('cachePoint block is dropped', () => {
    const bedrock = [{ text: 'a' }, { cachePoint: { type: 'default' } }] as unknown as ContentBlock[]
    const neutral = toNeutral(bedrock)
    expect(neutral).toEqual([{ kind: 'text', text: 'a' }])
  })

  test('multi-block turn preserves order', () => {
    const bedrock: ContentBlock[] = [
      { reasoningContent: { reasoningText: { text: 'let me think', signature: 'sig' } } },
      { text: 'here is my answer' },
      { toolUse: { toolUseId: 'tu1', name: 'web_search', input: { query: 'x' } } },
    ]
    const neutral = toNeutral(bedrock)
    expect(neutral.map(b => b.kind)).toEqual(['thinking', 'text', 'tool_call'])
    expect(fromNeutral(neutral)).toEqual(bedrock)
  })
})
