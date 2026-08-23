import { buildToolList } from '../../../src/lib/llm/toolGating'

test('read_research_findings is offered only for a chat with a completed research run', () => {
  const names = (list: ReturnType<typeof buildToolList>) => list.map(t => t.name)

  expect(names(buildToolList({}, { sub: 'u1', chatId: 'c1', hasResearch: true }))).toContain('read_research_findings')
  expect(names(buildToolList({}, { sub: 'u1', chatId: 'c1' }))).not.toContain('read_research_findings')
  expect(names(buildToolList({}, { sub: 'u1', hasResearch: true }))).not.toContain('read_research_findings')
  expect(names(buildToolList({}))).not.toContain('read_research_findings')
})
