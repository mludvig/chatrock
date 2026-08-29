import { handler } from '../../src/research/report'
import * as bedrock from '../../src/lib/bedrock'
import * as dynamo from '../../src/lib/dynamo'
import * as projectFiles from '../../src/lib/projectFiles'

jest.mock('../../src/lib/bedrock')
jest.mock('../../src/lib/dynamo', () => ({
  ...jest.requireActual('../../src/lib/dynamo'),
  getChat: jest.fn(),
  putMessage: jest.fn(),
  updateChatActiveLeaf: jest.fn(),
  updateRun: jest.fn(),
  updateChatHasResearch: jest.fn(),
  putProject: jest.fn(),
  updateChatProject: jest.fn(),
  putProjectFile: jest.fn(),
}))
jest.mock('../../src/lib/projectFiles', () => ({
  summarizeFile: jest.fn(),
}))
jest.mock('../../src/lib/enrichment', () => ({
  generateChatTitle: jest.fn(),
}))
jest.mock('../../src/research/model', () => ({ resolveRunModel: jest.fn().mockResolvedValue('test-model') }))
jest.mock('../../src/research/attachments', () => ({ resolveRunAttachmentBlocks: jest.fn().mockResolvedValue([]) }))
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
  PutObjectCommand: jest.fn(),
}))

const mockBedrock = bedrock as jest.Mocked<typeof bedrock>
const mockDynamo = dynamo as jest.Mocked<typeof dynamo>
const mockProjectFiles = projectFiles as jest.Mocked<typeof projectFiles>
const mockResolveRunAttachmentBlocks = jest.requireMock('../../src/research/attachments').resolveRunAttachmentBlocks as jest.Mock

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

test('report handler — prepends the question\'s attachment blocks ahead of the text block', async () => {
  const imageBlock = { kind: 'image', image: { format: 'png', source: { bytes: new Uint8Array([1]) } } }
  mockResolveRunAttachmentBlocks.mockResolvedValue([imageBlock])
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#chat-1', activeLeafId: 'leaf-9' })
  mockBedrock.converseOnce.mockResolvedValue('answer')

  await handler(BASE_INPUT)

  const content = mockBedrock.converseOnce.mock.calls[0][2][0].content
  expect(content[0]).toEqual(imageBlock)
  expect(content[1]).toMatchObject({ kind: 'text' })
})

describe('research dossier', () => {
  test('chat already in a project — the dossier is filed there', async () => {
    mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#chat-1', activeLeafId: 'leaf-9', projectId: 'proj-existing' })
    mockBedrock.converseOnce.mockResolvedValue('answer')

    await handler(BASE_INPUT)

    expect(mockDynamo.putProjectFile).toHaveBeenCalledTimes(1)
    const file = mockDynamo.putProjectFile.mock.calls[0][0] as Record<string, unknown>
    expect(file.PK).toBe('PROJECT#proj-existing')
    expect(file.status).toBe('ready')
    expect(file.inclusion).toBe('auto')
    expect(file.microLabel).toBe('Dossier')
    // Recorded so a later move into the same project doesn't file a duplicate copy.
    expect(mockDynamo.updateRun).toHaveBeenCalledWith('chat-1', 'run-1', { dossierProjectId: 'proj-existing' })
  })

  test('chat with no project — no project is created and no dossier file is written', async () => {
    mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#chat-1', activeLeafId: 'leaf-9' })
    mockBedrock.converseOnce.mockResolvedValue('answer')

    await handler(BASE_INPUT)

    expect(mockDynamo.putProject).not.toHaveBeenCalled()
    expect(mockDynamo.updateChatProject).not.toHaveBeenCalled()
    expect(mockDynamo.putProjectFile).not.toHaveBeenCalled()
    // The findings are still reachable — read_research_findings is unlocked on the chat.
    expect(mockDynamo.updateChatHasResearch).toHaveBeenCalledWith('user-1', 'chat-1')
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

  test('sensitive chat in a project — no dossier file is written', async () => {
    mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#chat-1', activeLeafId: 'leaf-9', projectId: 'proj-1', sensitive: true })
    mockBedrock.converseOnce.mockResolvedValue('answer')

    await handler(BASE_INPUT)

    expect(mockDynamo.putProjectFile).not.toHaveBeenCalled()
    expect(mockProjectFiles.summarizeFile).not.toHaveBeenCalled()
  })
})
