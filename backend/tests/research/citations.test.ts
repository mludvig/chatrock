import { linkifyReportCitations } from '../../src/research/citations'

test('links inline citations and the Sources list entries to their URLs', () => {
  const input = [
    'Cross-lease titles split ownership of the land [1]. A survey-strata conversion is one fix [2].',
    '',
    '## Sources',
    '1. https://example.com/cross-lease',
    '2. https://example.co.nz/survey-strata',
  ].join('\n')

  const result = linkifyReportCitations(input)

  expect(result).toContain('split ownership of the land [1](https://example.com/cross-lease)')
  expect(result).toContain('is one fix [2](https://example.co.nz/survey-strata)')
  expect(result).toContain('1. [https://example.com/cross-lease](https://example.com/cross-lease)')
  expect(result).toContain('2. [https://example.co.nz/survey-strata](https://example.co.nz/survey-strata)')
})

test('leaves a citation number with no matching source untouched', () => {
  const input = 'Some claim [3].\n\n## Sources\n1. https://example.com/a'
  const result = linkifyReportCitations(input)
  expect(result).toContain('Some claim [3].')
})

test('returns the text unchanged when there is no Sources list', () => {
  const input = 'Plain answer with no citations at all.'
  expect(linkifyReportCitations(input)).toBe(input)
})
