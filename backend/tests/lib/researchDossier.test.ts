import { writeDossiersForChatMove, buildDossierMarkdown } from '../../src/lib/researchDossier'
import * as dynamo from '../../src/lib/dynamo'
import * as projectFiles from '../../src/lib/projectFiles'

jest.mock('../../src/lib/dynamo', () => ({
  ...jest.requireActual('../../src/lib/dynamo'),
  listRuns: jest.fn(),
  putProjectFile: jest.fn(),
  updateRun: jest.fn(),
}))
jest.mock('../../src/lib/projectFiles', () => ({ summarizeFile: jest.fn() }))
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
  PutObjectCommand: jest.fn(),
}))

const mockDynamo = dynamo as jest.Mocked<typeof dynamo>
const mockProjectFiles = projectFiles as jest.Mocked<typeof projectFiles>

const DONE_RUN = {
  runId: 'run-1',
  status: 'done',
  question: 'What is X?',
  plan: { subQuestions: [{ id: 'sq1', question: 'Origins of X?' }], clarifyingQuestions: [] },
  findings: [{ subQuestionId: 'sq1', summary: 'X came from Y.', sourceUrls: ['https://example.com'] }],
  gapsNotPursued: ['exact date'],
  reportText: 'The report.',
}

beforeEach(() => {
  jest.clearAllMocks()
  mockProjectFiles.summarizeFile.mockResolvedValue({ microLabel: 'Dossier', summary: 'A dossier.' })
})

test('writeDossiersForChatMove — files a completed run\'s dossier into the project', async () => {
  mockDynamo.listRuns.mockResolvedValue([DONE_RUN] as never)

  await writeDossiersForChatMove('user-1', 'chat-1', 'proj-1')

  expect(mockDynamo.putProjectFile).toHaveBeenCalledTimes(1)
  const file = mockDynamo.putProjectFile.mock.calls[0][0] as Record<string, unknown>
  expect(file.PK).toBe('PROJECT#proj-1')
  expect(file.filename).toBe('research-dossier.md')
  expect(mockDynamo.updateRun).toHaveBeenCalledWith('chat-1', 'run-1', { dossierProjectId: 'proj-1' })
})

test('writeDossiersForChatMove — skips runs that are not finished', async () => {
  mockDynamo.listRuns.mockResolvedValue([{ ...DONE_RUN, status: 'running', reportText: undefined }] as never)

  await writeDossiersForChatMove('user-1', 'chat-1', 'proj-1')

  expect(mockDynamo.putProjectFile).not.toHaveBeenCalled()
})

test('writeDossiersForChatMove — skips a run already filed in this project', async () => {
  mockDynamo.listRuns.mockResolvedValue([{ ...DONE_RUN, dossierProjectId: 'proj-1' }] as never)

  await writeDossiersForChatMove('user-1', 'chat-1', 'proj-1')

  expect(mockDynamo.putProjectFile).not.toHaveBeenCalled()
})

test('writeDossiersForChatMove — a run filed elsewhere is filed again in the new project', async () => {
  mockDynamo.listRuns.mockResolvedValue([{ ...DONE_RUN, dossierProjectId: 'proj-old' }] as never)

  await writeDossiersForChatMove('user-1', 'chat-1', 'proj-1')

  expect(mockDynamo.putProjectFile).toHaveBeenCalledTimes(1)
})

test('buildDossierMarkdown — renders report, plan, findings with sources, and gaps', () => {
  const md = buildDossierMarkdown(DONE_RUN)

  expect(md).toContain('# Research dossier: What is X?')
  expect(md).toContain('The report.')
  expect(md).toContain('- Origins of X?')
  expect(md).toContain('X came from Y.')
  expect(md).toContain('Sources: https://example.com')
  expect(md).toContain('- exact date')
})
