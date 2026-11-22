import { adaptDocuments, textDocument } from '../../../src/lib/llm/documents'
import type { NeutralMessage } from '../../../src/lib/llm/blocks'

const bytes = (s: string) => ({ bytes: new TextEncoder().encode(s) })

const history: NeutralMessage[] = [
  {
    role: 'user',
    content: [
      { kind: 'text', text: 'Read these.' },
      { kind: 'document', document: { format: 'pdf', name: 'report.pdf', source: bytes('%PDF-1.4') } },
      { kind: 'document', document: { format: 'md', name: 'notes.md', source: bytes('# Notes') } },
      { kind: 'image', image: { format: 'png', source: bytes('png') } },
    ],
  },
  { role: 'assistant', content: [{ kind: 'tool_call', callId: 'c1', name: 'read_project_file', input: {} }] },
  {
    role: 'user',
    content: [{
      kind: 'tool_result', callId: 'c1', isError: false,
      entries: [{ kind: 'document', document: { format: 'pdf', name: 'spec.pdf', source: { s3Uri: 's3://b/k' } } }],
    }],
  },
]

test('a model that reads PDFs gets the history unchanged', () => {
  expect(adaptDocuments(history, { pdf: true, inlineText: true })).toBe(history)
})

test('without PDF support each PDF becomes a note, top-level and inside a tool result', () => {
  const out = adaptDocuments(history, { pdf: false, inlineText: false })
  expect(out[0].content[1]).toEqual({ kind: 'text', text: '[PDF "report.pdf" omitted: this model can\'t read PDFs]' })
  expect(out[2].content[0]).toMatchObject({ kind: 'tool_result', entries: [{ kind: 'text', text: '[PDF "spec.pdf" omitted: this model can\'t read PDFs]' }] })
})

test('text documents stay documents unless inlineText is set', () => {
  expect(adaptDocuments(history, { pdf: false, inlineText: false })[0].content[2]).toEqual(history[0].content[2])
  expect(adaptDocuments(history, { pdf: false, inlineText: true })[0].content[2]).toEqual({ kind: 'text', text: '<document name="notes.md">\n# Notes\n</document>' })
})

test('text, images and tool calls pass through', () => {
  const out = adaptDocuments(history, { pdf: false, inlineText: true })
  expect(out[0].content[0]).toEqual(history[0].content[0])
  expect(out[0].content[3]).toEqual(history[0].content[3])
  expect(out[1]).toEqual(history[1])
})

test('textDocument decodes bytes and wraps them with the name', () => {
  expect(textDocument({ format: 'txt', name: 'a.txt', source: bytes('hello') })).toBe('<document name="a.txt">\nhello\n</document>')
})
