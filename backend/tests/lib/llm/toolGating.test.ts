import { buildToolList } from '../../../src/lib/llm/toolGating'

test('read_research_findings is offered only for a sensitive chat with chatId', () => {
  const names = (list: ReturnType<typeof buildToolList>) => list.map(t => t.name)

  expect(names(buildToolList({}, { sub: 'u1', chatId: 'c1', sensitive: true }))).toContain('read_research_findings')
  expect(names(buildToolList({}, { sub: 'u1', chatId: 'c1' }))).not.toContain('read_research_findings')
  expect(names(buildToolList({}, { sub: 'u1', sensitive: true }))).not.toContain('read_research_findings')
  expect(names(buildToolList({}))).not.toContain('read_research_findings')
})
