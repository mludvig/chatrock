import { handler } from '../../src/research/report'
import * as bedrock from '../../src/lib/bedrock'
import * as dynamo from '../../src/lib/dynamo'

jest.mock('../../src/lib/bedrock')
jest.mock('../../src/lib/dynamo', () => ({
  ...jest.requireActual('../../src/lib/dynamo'),
  getChat: jest.fn(),
  putMessage: jest.fn(),
  updateChatActiveLeaf: jest.fn(),
  updateRun: jest.fn(),
}))

const mockBedrock = bedrock as jest.Mocked<typeof bedrock>
const mockDynamo = dynamo as jest.Mocked<typeof dynamo>

beforeEach(() => jest.clearAllMocks())

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
