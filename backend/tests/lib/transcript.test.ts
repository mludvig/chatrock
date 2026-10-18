import { filterSteps, renderMarkdown, renderHtml, groupTurnsToBubbles, type RawBubble, type TurnRow } from '../../src/lib/transcript'
import { renderChart } from '../../src/lib/visuals/chart'

const bubble = (overrides: Partial<RawBubble>): RawBubble => ({
  msgId: 'm1', parentId: null, role: 'assistant', steps: [], model: 'claude', createdAt: 't',
  ...overrides,
})

test('visuals survive durable grouping and clean share/export without exposing executable markup', () => {
  const visual = renderChart('Revenue', { type: 'bar', labels: ['Q1', 'Q2'], series: [{ name: 'USD', values: [10, 20] }] })
  const base = { PK: 'CHAT#c', SK: 'MSG#x', model: 'small', createdAt: 't', turnIndex: 0, responseId: 'r' }
  const rows: TurnRow[] = [
    { ...base, msgId: 'a', parentId: null, role: 'assistant', blocks: [{ kind: 'tool_call', callId: 'v', name: 'create_visual', input: { title: 'Revenue' } }] },
    { ...base, msgId: 'b', parentId: 'a', role: 'user', blocks: [{ kind: 'tool_result', callId: 'v', entries: [{ kind: 'text', text: 'Created' }], isError: false, visual }] },
  ]
  const bubbles = filterSteps(groupTurnsToBubbles(rows).bubbles, { includeTools: false, includeThinking: false })
  const step = bubbles[0].steps[0]
  expect(step.kind === 'tool' && step.visual).toEqual(visual)
  const markdown = renderMarkdown(bubbles, { title: 'T', htmlUrl: 'https://example.com/s/test' })
  expect(markdown).toContain('| Q2 | 20 |')
  expect(markdown).toContain('[Open the visual in HTML](https://example.com/s/test)')
  expect(markdown).not.toContain(visual.source)
  expect(renderMarkdown(bubbles, { title: 'T', includeVisualSource: true })).toContain('```svg')
  const html = renderHtml(bubbles, { title: 'T' })
  expect(html).toContain('sandbox="allow-scripts"')
  expect(html).toContain('srcdoc=')
  expect(html).not.toContain(visual.source)
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

  test('drops an empty/whitespace-only thinking step even when includeThinking is true', () => {
    const bubbles = [bubble({
      steps: [
        { kind: 'thinking', text: '' },
        { kind: 'thinking', text: '   \n  ' },
        { kind: 'thinking', text: 'real reasoning' },
        { kind: 'text', text: 'answer' },
      ],
    })]
    const out = filterSteps(bubbles, { includeThinking: true, includeTools: false })
    expect(out[0].steps).toEqual([
      { kind: 'thinking', text: 'real reasoning' },
      { kind: 'text', text: 'answer' },
    ])
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

describe('groupTurnsToBubbles', () => {
  test('a user message injected mid-response splits the answer around its own bubble', () => {
    const row = (msgId: string, parentId: string | null, role: 'user' | 'assistant', blocks: unknown[]): TurnRow => ({
      PK: 'CHAT#c', SK: `MSG#t#${msgId}`, msgId, parentId, role, blocks, model: 'm', createdAt: 't', turnIndex: 0, responseId: 'r1',
    } as unknown as TurnRow)
    const rows = [
      row('u1', null, 'user', [{ kind: 'text', text: 'Research A' }]),
      row('a1', 'u1', 'assistant', [{ kind: 'tool_call', callId: 't1', name: 'web_search', input: {} }]),
      row('tr1', 'a1', 'user', [{ kind: 'tool_result', callId: 't1', entries: [{ kind: 'text', text: 'r' }], isError: false }]),
      row('u2', 'tr1', 'user', [{ kind: 'text', text: 'Focus on X' }]),
      row('a2', 'u2', 'assistant', [{ kind: 'text', text: 'Focused on X.' }]),
    ]
    const { bubbles } = groupTurnsToBubbles(rows)
    expect(bubbles.map(b => [b.role, b.msgId, b.parentId])).toEqual([
      ['user', 'u1', null],
      ['assistant', 'a1', 'u1'],
      ['user', 'u2', 'tr1'],
      ['assistant', 'a2', 'u2'],
    ])
  })
})
