import { executeReadResearchFindingsTool } from '../../src/lib/researchFindings'
import * as dynamo from '../../src/lib/dynamo'

jest.mock('../../src/lib/dynamo', () => ({
  listRuns: jest.fn(),
}))

const mockDynamo = dynamo as jest.Mocked<typeof dynamo>

beforeEach(() => jest.clearAllMocks())

const DONE_RUN = {
  status: 'done',
  updatedAt: '2026-08-20T00:00:00.000Z',
  question: 'What is the history of X?',
  plan: { subQuestions: [{ id: 'sq1', question: 'Origins of X?' }], clarifyingQuestions: [] },
  findings: [{ subQuestionId: 'sq1', summary: 'X originated in Y.', sourceUrls: ['https://example.com'] }],
  gapsNotPursued: ['Did not verify the exact date'],
  reportText: 'X originated in Y [1].',
}

test('no chatId in context — errors', async () => {
  const result = await executeReadResearchFindingsTool({ detail: 'summary' }, { sub: 'user-1' })
  expect(result.isError).toBe(true)
})

test('no completed run for the chat — errors', async () => {
  mockDynamo.listRuns.mockResolvedValue([{ status: 'running' }])
  const result = await executeReadResearchFindingsTool({ detail: 'summary' }, { sub: 'user-1', chatId: 'chat-1' })
  expect(result.isError).toBe(true)
})

test('summary detail — report and gaps, no findings/sources', async () => {
  mockDynamo.listRuns.mockResolvedValue([DONE_RUN])
  const result = await executeReadResearchFindingsTool({ detail: 'summary' }, { sub: 'user-1', chatId: 'chat-1' })
  const text = (result.entries[0] as { text: string }).text
  expect(text).toContain('X originated in Y [1].')
  expect(text).toContain('Did not verify the exact date')
  expect(text).not.toContain('https://example.com')
})

test('full detail — includes findings and source URLs', async () => {
  mockDynamo.listRuns.mockResolvedValue([DONE_RUN])
  const result = await executeReadResearchFindingsTool({ detail: 'full' }, { sub: 'user-1', chatId: 'chat-1' })
  const text = (result.entries[0] as { text: string }).text
  expect(text).toContain('X originated in Y.')
  expect(text).toContain('https://example.com')
  expect(text).toContain('Origins of X?')
})

test('multiple completed runs — picks the most recently updated one', async () => {
  const older = { ...DONE_RUN, reportText: 'Old report', updatedAt: '2026-08-01T00:00:00.000Z' }
  mockDynamo.listRuns.mockResolvedValue([older, DONE_RUN])
  const result = await executeReadResearchFindingsTool({ detail: 'summary' }, { sub: 'user-1', chatId: 'chat-1' })
  const text = (result.entries[0] as { text: string }).text
  expect(text).toContain('X originated in Y [1].')
  expect(text).not.toContain('Old report')
})
