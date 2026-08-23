import { handler } from '../../src/research/report'
import * as bedrock from '../../src/lib/bedrock'
import * as dynamo from '../../src/lib/dynamo'
import * as projectFiles from '../../src/lib/projectFiles'
import * as enrichment from '../../src/lib/enrichment'

jest.mock('../../src/lib/bedrock')
jest.mock('../../src/lib/dynamo', () => ({
  ...jest.requireActual('../../src/lib/dynamo'),
  getChat: jest.fn(),
  putMessage: jest.fn(),
  updateChatActiveLeaf: jest.fn(),
  updateRun: jest.fn(),
  putProject: jest.fn(),
  updateChatProject: jest.fn(),
  putProjectFile: jest.fn(),
}))
jest.mock('../../src/lib/projectFiles', () => ({
  summarizeFile: jest.fn(),
}))
jest.mock('../../src/lib/enrichment', () => ({
  summarizeChatById: jest.fn(),
  enrichProjectFactsByChatId: jest.fn(),
}))
jest.mock('../../src/research/model', () => ({ resolveRunModel: jest.fn().mockResolvedValue('test-model') }))
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
  PutObjectCommand: jest.fn(),
}))

const mockBedrock = bedrock as jest.Mocked<typeof bedrock>
const mockDynamo = dynamo as jest.Mocked<typeof dynamo>
const mockProjectFiles = projectFiles as jest.Mocked<typeof projectFiles>
const mockEnrichment = enrichment as jest.Mocked<typeof enrichment>

beforeEach(() => {
  jest.clearAllMocks()
  mockProjectFiles.summarizeFile.mockResolvedValue({ microLabel: 'Dossier', summary: 'A research dossier.' })
})

const BASE_INPUT = {
  chatId: 'chat-1',
  runId: 'run-1',
  sub: 'user-1',
  question: 'What is the history of X?',
  plan: { subQuestions: [{ id: 'sq1', question: 'Origins of X?' }], clarifyingQuestions: [] },
  findings: [{ subQuestionId: 'sq1', summary: 'X originated in Y.', sourceUrls: ['https://example.com'] }],
  gapsNotPursued: ['Did not verify the exact date'],
}

test('report handler — persists the synthesised answer as an assistant turn chained under activeLeafId', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#chat-1', activeLeafId: 'leaf-9' })
  mockBedrock.converseOnce.mockResolvedValue('X originated in Y [1].\n\nSources:\n[1] https://example.com')

  const result = await handler(BASE_INPUT)

  expect(result.reportText).toBe('X originated in Y [1].\n\nSources:\n[1] https://example.com')
  expect(mockDynamo.putMessage).toHaveBeenCalledTimes(1)
  const turn = mockDynamo.putMessage.mock.calls[0][0] as Record<string, unknown>
  expect(turn.role).toBe('assistant')
  expect(turn.parentId).toBe('leaf-9')
  expect(turn.blocks).toEqual([{ kind: 'text', text: result.reportText }])
  // The turn records the run's model, not the global default — see docs/adr/0030.
  expect(turn.model).toBe('test-model')
  expect(mockBedrock.converseOnce.mock.calls[0][0]).toBe('test-model')
  expect(mockDynamo.updateChatActiveLeaf).toHaveBeenCalledWith('user-1', 'chat-1', turn.msgId)
  expect(mockDynamo.updateRun).toHaveBeenCalledWith('chat-1', 'run-1', { status: 'done', reportText: result.reportText })
})

test('report handler — chat with no activeLeafId yet gets a null parentId', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#chat-1' })
  mockBedrock.converseOnce.mockResolvedValue('answer')

  await handler(BASE_INPUT)

  const turn = mockDynamo.putMessage.mock.calls[0][0] as Record<string, unknown>
  expect(turn.parentId).toBeNull()
})

test('report handler — includes findings and gaps in the prompt sent to the model', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#chat-1', activeLeafId: 'leaf-9' })
  mockBedrock.converseOnce.mockResolvedValue('answer')

  await handler(BASE_INPUT)

  const [, , messages] = mockBedrock.converseOnce.mock.calls[0]
  const userText = (messages[0].content[0] as { text: string }).text
  expect(userText).toContain('X originated in Y.')
  expect(userText).toContain('https://example.com')
  expect(userText).toContain('Did not verify the exact date')
})

describe('research dossier', () => {
  test('chat already in a project — dossier is written there, no new project created', async () => {
    mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#chat-1', activeLeafId: 'leaf-9', projectId: 'proj-existing' })
    mockBedrock.converseOnce.mockResolvedValue('answer')

    await handler(BASE_INPUT)

    expect(mockDynamo.putProject).not.toHaveBeenCalled()
    expect(mockDynamo.updateChatProject).not.toHaveBeenCalled()
    expect(mockDynamo.putProjectFile).toHaveBeenCalledTimes(1)
    const file = mockDynamo.putProjectFile.mock.calls[0][0] as Record<string, unknown>
    expect(file.PK).toBe('PROJECT#proj-existing')
    expect(file.status).toBe('ready')
    expect(file.inclusion).toBe('auto')
    expect(file.microLabel).toBe('Dossier')
  })

  test('chat with no project — a project is created from the question and the chat is moved into it', async () => {
    mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#chat-1', activeLeafId: 'leaf-9' })
    mockBedrock.converseOnce.mockResolvedValue('answer')

    await handler(BASE_INPUT)

    expect(mockDynamo.putProject).toHaveBeenCalledTimes(1)
    const project = mockDynamo.putProject.mock.calls[0][0] as Record<string, unknown>
    expect(project.name).toBe(BASE_INPUT.question)
    expect(mockDynamo.updateChatProject).toHaveBeenCalledWith('user-1', 'chat-1', project.projectId)
    expect(mockEnrichment.summarizeChatById).toHaveBeenCalledWith('user-1', 'chat-1')
    expect(mockEnrichment.enrichProjectFactsByChatId).toHaveBeenCalledWith('chat-1', project.projectId)
    const file = mockDynamo.putProjectFile.mock.calls[0][0] as Record<string, unknown>
    expect(file.PK).toBe(`PROJECT#${project.projectId}`)
  })

  test('dossier markdown includes the report, plan, findings with sources, and gaps', async () => {
    mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#chat-1', activeLeafId: 'leaf-9', projectId: 'proj-1' })
    mockBedrock.converseOnce.mockResolvedValue('The synthesised answer.')

    await handler(BASE_INPUT)

    const putCommandCtor = (jest.requireMock('@aws-sdk/client-s3') as { PutObjectCommand: jest.Mock }).PutObjectCommand
    const body = putCommandCtor.mock.calls[0][0].Body as string
    expect(body).toContain('The synthesised answer.')
    expect(body).toContain('Origins of X?')
    expect(body).toContain('X originated in Y.')
    expect(body).toContain('https://example.com')
    expect(body).toContain('Did not verify the exact date')
  })

  test('sensitive chat — no project is created and no dossier file is written', async () => {
    mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#chat-1', activeLeafId: 'leaf-9', sensitive: true })
    mockBedrock.converseOnce.mockResolvedValue('answer')

    await handler(BASE_INPUT)

    expect(mockDynamo.putProject).not.toHaveBeenCalled()
    expect(mockDynamo.updateChatProject).not.toHaveBeenCalled()
    expect(mockDynamo.putProjectFile).not.toHaveBeenCalled()
    expect(mockProjectFiles.summarizeFile).not.toHaveBeenCalled()
  })
})
