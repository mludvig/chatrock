import { filterSteps, renderMarkdown, renderHtml, type RawBubble } from '../../src/lib/transcript'

const bubble = (overrides: Partial<RawBubble>): RawBubble => ({
  msgId: 'm1', parentId: null, role: 'assistant', steps: [], model: 'claude', createdAt: 't',
  ...overrides,
})

describe('filterSteps', () => {
  test('clean (both false) drops thinking and tool steps, keeps text/attachment', () => {
    const bubbles = [bubble({
      steps: [
        { kind: 'thinking', text: 'reasoning' },
        { kind: 'tool', toolUseId: 't1', name: 'web_search', input: '{}' },
        { kind: 'text', text: 'answer' },
        { kind: 'attachment', attachmentKind: 'image', filename: 'x.png', contentType: 'image/png', url: 'u', s3Key: 'k' },
      ],
    })]
    const out = filterSteps(bubbles, { includeThinking: false, includeTools: false })
    expect(out[0].steps.map(s => s.kind)).toEqual(['text', 'attachment'])
  })

  test('includeThinking:true, includeTools:false keeps thinking but drops tool', () => {
    const bubbles = [bubble({
      steps: [
        { kind: 'thinking', text: 'reasoning' },
        { kind: 'tool', toolUseId: 't1', name: 'web_search', input: '{}' },
        { kind: 'text', text: 'answer' },
      ],
    })]
    const out = filterSteps(bubbles, { includeThinking: true, includeTools: false })
    expect(out[0].steps.map(s => s.kind)).toEqual(['thinking', 'text'])
  })

  test('does not mutate the input bubbles array', () => {
    const bubbles = [bubble({ steps: [{ kind: 'thinking', text: 'x' }] }) ]
    filterSteps(bubbles, { includeThinking: false, includeTools: false })
    expect(bubbles[0].steps).toHaveLength(1)
  })
})

describe('renderMarkdown', () => {
  test('emits a title heading, clear per-turn separators, and plain-text (no emoji) role headings', () => {
    const bubbles = [
      bubble({ role: 'user', steps: [{ kind: 'text', text: 'Hello' }] }),
      bubble({ role: 'assistant', model: 'opus', steps: [{ kind: 'text', text: 'Hi there' }] }),
    ]
    const out = renderMarkdown(bubbles, { title: 'My Chat' })
    expect(out).toContain('# My Chat')
    expect(out).toContain('## User')
    expect(out).toContain('## Assistant (opus)')
    expect(out).toContain('Hello')
    expect(out).toContain('Hi there')
    expect(out).toContain('---')
    // no emoji anywhere in generated headings
    expect(out).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
  })

  test('renders a thinking step as a blockquote and a tool step with input/result fences', () => {
    const bubbles = [bubble({
      steps: [
        { kind: 'thinking', text: 'let me think' },
        { kind: 'tool', toolUseId: 't1', name: 'web_search', input: '{"query":"x"}', result: 'found stuff' },
        { kind: 'text', text: 'final' },
      ],
    })]
    const out = renderMarkdown(bubbles, { title: 'T' })
    expect(out).toContain('> **Thinking**')
    expect(out).toContain('let me think')
    expect(out).toContain('**Tool call: `web_search`**')
    expect(out).toContain('found stuff')
    expect(out).toContain('final')
  })

  test('an empty-steps bubble (fully filtered out) still gets a placeholder, not a blank gap', () => {
    const bubbles = [bubble({ role: 'assistant', steps: [] })]
    const out = renderMarkdown(bubbles, { title: 'T' })
    expect(out).toContain('_(empty)_')
  })
})

describe('renderHtml', () => {
  test('produces a self-contained document with inline styles and no external asset requests', () => {
    const bubbles = [bubble({ role: 'user', steps: [{ kind: 'text', text: 'Hello **world**' }] })]
    const out = renderHtml(bubbles, { title: 'My Chat' })
    expect(out).toContain('<!doctype html>')
    expect(out).toContain('<style>')
    expect(out).not.toMatch(/<link\s+rel=["']stylesheet["']/)
    expect(out).not.toMatch(/<script\s+src=/)
    expect(out).toContain('My Chat')
    expect(out).toContain('<strong>world</strong>')
  })

  test('escapes chat title and tool step content to prevent HTML injection', () => {
    const bubbles = [bubble({
      role: 'assistant',
      steps: [{ kind: 'tool', toolUseId: 't1', name: '<img src=x onerror=alert(1)>', input: '{}' }],
    })]
    const out = renderHtml(bubbles, { title: '<script>alert(1)</script>' })
    expect(out).not.toContain('<script>alert(1)</script>')
    expect(out).toContain('&lt;script&gt;')
    expect(out).not.toContain('<img src=x onerror=alert(1)>')
  })

  test('renders thinking/tool as collapsible <details> blocks', () => {
    const bubbles = [bubble({
      steps: [
        { kind: 'thinking', text: 'reasoning' },
        { kind: 'tool', toolUseId: 't1', name: 'web_search', input: '{}', result: 'ok' },
      ],
    })]
    const out = renderHtml(bubbles, { title: 'T' })
    expect(out).toContain('<details class="thinking">')
    expect(out).toContain('<details class="tool">')
  })
})
