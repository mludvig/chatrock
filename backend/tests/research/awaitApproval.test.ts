import { handler } from '../../src/research/awaitApproval'
import * as dynamo from '../../src/lib/dynamo'
import * as wsNotify from '../../src/lib/wsNotify'

jest.mock('../../src/lib/dynamo', () => ({
  ...jest.requireActual('../../src/lib/dynamo'),
  updateRun: jest.fn(),
  getRun: jest.fn(),
  getChat: jest.fn(),
  putMessage: jest.fn(),
  updateChatActiveLeaf: jest.fn(),
}))
jest.mock('../../src/lib/wsNotify', () => ({ notifyConnection: jest.fn() }))

const mockDynamo = dynamo as jest.Mocked<typeof dynamo>
const mockNotify = wsNotify as jest.Mocked<typeof wsNotify>

const PLAN = {
  subQuestions: [{ id: 'sq1', question: 'What is X?' }, { id: 'sq2', question: 'What is Y?' }],
  clarifyingQuestions: ['Which region?'],
}

const EVENT = {
  chatId: 'chat-1',
  runId: 'run-1',
  sub: 'user-1',
  connId: 'conn-1',
  question: 'what is X',
  plan: PLAN,
  taskToken: 'token-abc',
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDynamo.updateRun.mockResolvedValue(undefined)
  mockDynamo.getRun.mockResolvedValue(undefined as never)
  mockDynamo.getChat.mockResolvedValue({ activeLeafId: 'leaf-1' } as never)
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)
})

test('persists question, plan, and task token, initialising run-loop defaults', async () => {
  await handler(EVENT)

  expect(mockDynamo.updateRun).toHaveBeenCalledWith('chat-1', 'run-1', {
    runId: 'run-1',
    chatId: 'chat-1',
    sub: 'user-1',
    status: 'awaiting_approval',
    question: 'what is X',
    plan: PLAN,
    taskToken: 'token-abc',
    findings: [],
    gapsNotPursued: [],
    steeringNotes: [],
    roundsSpent: 0,
  })
})

test('writes the plan as an assistant turn on the active branch, numbered as the user will answer it', async () => {
  await handler(EVENT)

  const turn = mockDynamo.putMessage.mock.calls[0][0] as Record<string, unknown>
  expect(turn.role).toBe('assistant')
  expect(turn.parentId).toBe('leaf-1')
  const text = (turn.blocks as { text: string }[])[0].text
  expect(text).toContain('1. Which region?')
  expect(text).toContain('1. What is X?')
  expect(text).toContain('2. What is Y?')
  expect(mockDynamo.updateChatActiveLeaf).toHaveBeenCalledWith('user-1', 'chat-1', turn.msgId)
})

test('announces the plan only once it is durable, carrying the turn it was written as', async () => {
  await handler(EVENT)

  const turn = mockDynamo.putMessage.mock.calls[0][0] as Record<string, unknown>
  expect(mockNotify.notifyConnection).toHaveBeenCalledWith('conn-1', {
    type: 'research_plan', runId: 'run-1', chatId: 'chat-1', plan: PLAN, msgId: turn.msgId,
  })
  const notifyOrder = mockNotify.notifyConnection.mock.invocationCallOrder[0]
  expect(mockDynamo.putMessage.mock.invocationCallOrder[0]).toBeLessThan(notifyOrder)
})
