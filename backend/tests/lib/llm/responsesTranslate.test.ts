import type { ResponseOutputItem } from 'openai/resources/responses/responses'
import { toNeutral, fromNeutralMessages } from '../../../src/lib/llm/providers/responsesTranslate'
import { encodeOpaque, decodeOpaque, type Block, type NeutralMessage } from '../../../src/lib/llm/blocks'

const M = 'global.openai.gpt-6-sol'

describe('responsesTranslate: toNeutral (output items -> Block[])', () => {
  test('message item with output_text becomes a text block', () => {
    const items = [
      { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] },
    ] as unknown as ResponseOutputItem[]
    expect(toNeutral(items, M)).toEqual([{ kind: 'text', text: 'hello' }])
  })

  test('message item with a refusal part surfaces as text', () => {
    const items = [
      { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'cannot help with that' }] },
    ] as unknown as ResponseOutputItem[]
    expect(toNeutral(items, M)).toEqual([{ kind: 'text', text: 'cannot help with that' }])
  })

  test('reasoning item becomes a thinking block with opaque{id, encryptedContent}', () => {
    const items = [
      { type: 'reasoning', id: 'rs_abc', summary: [{ type: 'summary_text', text: 'thinking about it' }], encrypted_content: 'ENCRYPTED_BLOB' },
    ] as unknown as ResponseOutputItem[]
    const neutral = toNeutral(items, M)
    expect(neutral).toHaveLength(1)
    expect(neutral[0]).toMatchObject({ kind: 'thinking', text: 'thinking about it' })
    const opaque = (neutral[0] as Extract<Block, { kind: 'thinking' }>).opaque!
    expect(opaque.provider).toBe('bedrock-responses')
    expect(decodeOpaque(opaque)).toEqual({ id: 'rs_abc', encryptedContent: 'ENCRYPTED_BLOB', model: M })
  })

  test('reasoning item with empty summary still carries opaque (id-only continuity)', () => {
    const items = [
      { type: 'reasoning', id: 'rs_xyz', summary: [] },
    ] as unknown as ResponseOutputItem[]
    const neutral = toNeutral(items, M)
    expect(neutral).toEqual([{ kind: 'thinking', text: '', opaque: expect.objectContaining({ provider: 'bedrock-responses' }) }])
  })

  test('function_call item becomes a tool_call block, arguments JSON-parsed', () => {
    const items = [
      { type: 'function_call', id: 'fc_1', call_id: 'call_abc123', name: 'web_search', arguments: '{"query":"weather"}', status: 'completed' },
    ] as unknown as ResponseOutputItem[]
    expect(toNeutral(items, M)).toEqual([{ kind: 'tool_call', callId: 'call_abc123', name: 'web_search', input: { query: 'weather' } }])
  })

  test('function_call item with malformed arguments JSON falls back to {}', () => {
    const items = [
      { type: 'function_call', id: 'fc_1', call_id: 'call_x', name: 'web_search', arguments: 'not json', status: 'completed' },
    ] as unknown as ResponseOutputItem[]
    expect(toNeutral(items, M)).toEqual([{ kind: 'tool_call', callId: 'call_x', name: 'web_search', input: {} }])
  })

  test('unrecognized item types (e.g. web_search_call) are dropped', () => {
    const items = [
      { type: 'web_search_call', id: 'ws_1', status: 'completed' },
      { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] },
    ] as unknown as ResponseOutputItem[]
    expect(toNeutral(items, M)).toEqual([{ kind: 'text', text: 'ok' }])
  })

  test('full agentic-round mix: reasoning, text, tool_call in order', () => {
    const items = [
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'plan' }] },
      { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'here is my answer', annotations: [] }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"x"}', status: 'completed' },
    ] as unknown as ResponseOutputItem[]
    const neutral = toNeutral(items, M)
    expect(neutral.map(b => b.kind)).toEqual(['thinking', 'text', 'tool_call'])
  })
})

describe('responsesTranslate: fromNeutralMessages (NeutralMessage[] -> flat input items)', () => {
  test('user text message -> one message item with input_text', () => {
    const messages: NeutralMessage[] = [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }]
    expect(fromNeutralMessages(messages, M)).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ])
  })

  test('assistant text message -> one message item with output_text (not input_text)', () => {
    const messages: NeutralMessage[] = [{ role: 'assistant', content: [{ kind: 'text', text: 'answer' }] }]
    const items = fromNeutralMessages(messages, M)
    expect(items).toEqual([
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer', annotations: [] }] },
    ])
  })

  test('tool_call and tool_result blocks become separate top-level items, not nested in a message', () => {
    const messages: NeutralMessage[] = [
      { role: 'assistant', content: [{ kind: 'tool_call', callId: 'call_1', name: 'web_search', input: { query: 'x' } }] },
      { role: 'user', content: [{ kind: 'tool_result', callId: 'call_1', entries: [{ kind: 'text', text: 'result text' }], isError: false }] },
    ]
    const items = fromNeutralMessages(messages, M)
    expect(items).toEqual([
      { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result text' },
    ])
  })

  test('tool_result with an image entry produces an array output with input_image', () => {
    const messages: NeutralMessage[] = [
      {
        role: 'user',
        content: [{
          kind: 'tool_result',
          callId: 'call_1',
          entries: [
            { kind: 'text', text: 'screenshot taken' },
            { kind: 'image', image: { format: 'png', source: { bytes: Buffer.from('PNG') } } },
          ],
          isError: false,
        }],
      },
    ]
    const items = fromNeutralMessages(messages, M) as Array<{ type: string; output: unknown }>
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('function_call_output')
    expect(items[0].output).toEqual([
      { type: 'input_text', text: 'screenshot taken' },
      { type: 'input_image', detail: 'auto', image_url: `data:image/png;base64,${Buffer.from('PNG').toString('base64')}` },
    ])
  })

  test('a message mixing text + tool_call splits into a message item and a separate function_call item, in order', () => {
    const messages: NeutralMessage[] = [
      {
        role: 'assistant',
        content: [
          { kind: 'text', text: 'let me check' },
          { kind: 'tool_call', callId: 'call_1', name: 'web_search', input: {} },
        ],
      },
    ]
    const items = fromNeutralMessages(messages, M)
    expect(items).toEqual([
      { role: 'assistant', content: [{ type: 'output_text', text: 'let me check', annotations: [] }] },
      { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{}' },
    ])
  })

  test('thinking block with our own opaque round-trips to a reasoning item', () => {
    const opaque = encodeOpaque('bedrock-responses', { id: 'rs_1', encryptedContent: 'ENC', model: M })
    const messages: NeutralMessage[] = [
      { role: 'assistant', content: [{ kind: 'thinking', text: 'plan', opaque }] },
    ]
    expect(fromNeutralMessages(messages, M)).toEqual([
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'plan' }], encrypted_content: 'ENC' },
    ])
  })

  test('reasoning produced by a different model is dropped — encrypted reasoning only decrypts for its own model', () => {
    const opaque = encodeOpaque('bedrock-responses', { id: 'rs_1', encryptedContent: 'ENC', model: 'global.openai.gpt-6-luna' })
    const messages: NeutralMessage[] = [
      { role: 'assistant', content: [{ kind: 'thinking', text: 'plan', opaque }, { kind: 'text', text: 'answer' }] },
    ]
    expect(fromNeutralMessages(messages, M)).toEqual([
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer', annotations: [] }] },
    ])
  })

  test('reasoning with no recorded model is dropped', () => {
    const opaque = encodeOpaque('bedrock-responses', { id: 'rs_1', encryptedContent: 'ENC' })
    const messages: NeutralMessage[] = [
      { role: 'assistant', content: [{ kind: 'thinking', text: 'plan', opaque }] },
    ]
    expect(fromNeutralMessages(messages, M)).toEqual([])
  })

  test('thinking block with foreign opaque (bedrock-converse) is dropped', () => {
    const opaque = encodeOpaque('bedrock-converse', { signature: 'sig' })
    const messages: NeutralMessage[] = [
      { role: 'assistant', content: [{ kind: 'thinking', text: 'claude thought', opaque }] },
      { role: 'assistant', content: [{ kind: 'text', text: 'answer' }] },
    ]
    const items = fromNeutralMessages(messages, M)
    expect(items).toEqual([
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer', annotations: [] }] },
    ])
  })

  test('thinking block with no opaque at all is dropped', () => {
    const messages: NeutralMessage[] = [
      { role: 'assistant', content: [{ kind: 'thinking', text: 'no signature' }] },
    ]
    expect(fromNeutralMessages(messages, M)).toEqual([])
  })

  test('document block: txt/md/csv inlined as tagged text, pdf as input_file', () => {
    const messages: NeutralMessage[] = [
      { role: 'user', content: [{ kind: 'document', document: { format: 'md', name: 'notes.md', source: { bytes: Buffer.from('# Title') } } }] },
      { role: 'user', content: [{ kind: 'document', document: { format: 'pdf', name: 'report.pdf', source: { bytes: Buffer.from('PDFDATA') } } }] },
    ]
    const items = fromNeutralMessages(messages, M)
    expect(items).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '<document name="notes.md">\n# Title\n</document>' }] },
      { role: 'user', content: [{ type: 'input_file', filename: 'report.pdf', file_data: `data:application/pdf;base64,${Buffer.from('PDFDATA').toString('base64')}` }] },
    ])
  })

  test('image block -> input_image with a base64 data URL', () => {
    const messages: NeutralMessage[] = [
      { role: 'user', content: [{ kind: 'image', image: { format: 'jpeg', source: { bytes: Buffer.from('JPGDATA') } } }] },
    ]
    expect(fromNeutralMessages(messages, M)).toEqual([
      { role: 'user', content: [{ type: 'input_image', detail: 'auto', image_url: `data:image/jpeg;base64,${Buffer.from('JPGDATA').toString('base64')}` }] },
    ])
  })

  test('empty messages array -> empty items array', () => {
    expect(fromNeutralMessages([], M)).toEqual([])
  })

  test('a message whose only block is a dropped foreign-thinking block contributes zero items (no dangling empty message)', () => {
    const opaque = encodeOpaque('bedrock-converse', { signature: 'sig' })
    const messages: NeutralMessage[] = [
      { role: 'assistant', content: [{ kind: 'thinking', text: 'x', opaque }] },
    ]
    expect(fromNeutralMessages(messages, M)).toEqual([])
  })
})

describe('responsesTranslate: round-trip (toNeutral then fromNeutralMessages)', () => {
  test('a full round-trips text + reasoning + tool_call through both directions', () => {
    const items = [
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'plan' }], encrypted_content: 'ENC' },
      { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'here is my answer', annotations: [] }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"x"}', status: 'completed' },
    ] as unknown as ResponseOutputItem[]

    const neutral = toNeutral(items, M)
    const roundTripped = fromNeutralMessages([{ role: 'assistant', content: neutral }], M)
    expect(roundTripped).toEqual([
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'plan' }], encrypted_content: 'ENC' },
      { role: 'assistant', content: [{ type: 'output_text', text: 'here is my answer', annotations: [] }] },
      { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"x"}' },
    ])
  })
})
