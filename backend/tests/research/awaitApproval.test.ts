import { handler } from '../../src/research/awaitApproval'
import * as dynamo from '../../src/lib/dynamo'

jest.mock('../../src/lib/dynamo', () => ({
  ...jest.requireActual('../../src/lib/dynamo'),
  updateRun: jest.fn(),
}))

const mockDynamo = dynamo as jest.Mocked<typeof dynamo>

beforeEach(() => jest.clearAllMocks())

test('persists question, plan, and task token, initialising run-loop defaults', async () => {
  mockDynamo.updateRun.mockResolvedValue(undefined)

  const plan = { subQuestions: [{ id: 'sq1', question: 'What is X?' }], clarifyingQuestions: [] }
  await handler({
    chatId: 'chat-1',
    runId: 'run-1',
    sub: 'user-1',
    question: 'what is X',
    plan,
    taskToken: 'token-abc',
  })

  expect(mockDynamo.updateRun).toHaveBeenCalledWith('chat-1', 'run-1', {
    runId: 'run-1',
    chatId: 'chat-1',
    sub: 'user-1',
    status: 'awaiting_approval',
    question: 'what is X',
    plan,
    taskToken: 'token-abc',
    findings: [],
    gapsNotPursued: [],
    steeringNotes: [],
    roundsSpent: 0,
  })
})
