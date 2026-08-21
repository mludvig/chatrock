import { handler } from '../../src/ws/startResearch'
import * as dynamo from '../../src/lib/dynamo'
import { SFNClient } from '@aws-sdk/client-sfn'

jest.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  StartExecutionCommand: jest.fn().mockImplementation(input => ({ input, kind: 'start' })),
}))

const mockSend = (SFNClient as jest.Mock).mock.results[0].value.send as jest.Mock

jest.mock('../../src/lib/dynamo', () => ({
  ...jest.requireActual('../../src/lib/dynamo'),
  getConnection: jest.fn(),
  getChat: jest.fn(),
  putMessage: jest.fn(),
  updateChatActiveLeaf: jest.fn(),
  putRun: jest.fn(),
}))

jest.mock('../../src/lib/ids', () => ({ newId: () => 'run-1' }))

const mockDynamo = dynamo as jest.Mocked<typeof dynamo>

const makeEvent = (body: object, connId = 'conn-1') => ({
  requestContext: { connectionId: connId },
  body: JSON.stringify(body),
})

beforeEach(() => jest.clearAllMocks())

test('returns 410 when the connection is gone', async () => {
  mockDynamo.getConnection.mockResolvedValue(undefined)

  const res = await handler(makeEvent({ chatId: 'chat-1', question: 'What is X?' }))

  expect((res as { statusCode: number }).statusCode).toBe(410)
  expect(mockDynamo.putRun).not.toHaveBeenCalled()
  expect(mockSend).not.toHaveBeenCalled()
})

test('returns 400 when chatId is missing', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1' })

  const res = await handler(makeEvent({ question: 'What is X?' }))

  expect((res as { statusCode: number }).statusCode).toBe(400)
  expect(mockDynamo.putRun).not.toHaveBeenCalled()
})

test('returns 400 when question is missing or blank', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1' })

  const res = await handler(makeEvent({ chatId: 'chat-1', question: '   ' }))

  expect((res as { statusCode: number }).statusCode).toBe(400)
  expect(mockDynamo.putRun).not.toHaveBeenCalled()
})

test('returns 404 when the chat does not exist', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1' })
  mockDynamo.getChat.mockResolvedValue(undefined)

  const res = await handler(makeEvent({ chatId: 'chat-1', question: 'What is X?' }))

  expect((res as { statusCode: number }).statusCode).toBe(404)
  expect(mockDynamo.putMessage).not.toHaveBeenCalled()
  expect(mockDynamo.putRun).not.toHaveBeenCalled()
})

test('persists the question as a user turn chained under activeLeafId, then mints a runId, writes the initial RUN# row, and starts the execution', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#chat-1', model: 'model-x', activeLeafId: 'leaf-9' })

  const res = await handler(makeEvent({ chatId: 'chat-1', question: 'What is X?' }))

  expect((res as { statusCode: number }).statusCode).toBe(200)
  expect(JSON.parse((res as { body: string }).body)).toEqual({ runId: 'run-1' })

  expect(mockDynamo.putMessage).toHaveBeenCalledTimes(1)
  const userTurn = mockDynamo.putMessage.mock.calls[0][0] as Record<string, unknown>
  expect(userTurn.role).toBe('user')
  expect(userTurn.parentId).toBe('leaf-9')
  expect(userTurn.blocks).toEqual([{ kind: 'text', text: 'What is X?' }])
  expect(mockDynamo.updateChatActiveLeaf).toHaveBeenCalledWith('user-1', 'chat-1', userTurn.msgId)

  expect(mockDynamo.putRun).toHaveBeenCalledTimes(1)
  const runRow = mockDynamo.putRun.mock.calls[0][0]
  expect(runRow).toMatchObject({
    runId: 'run-1',
    chatId: 'chat-1',
    sub: 'user-1',
    status: 'recon',
    question: 'What is X?',
    connId: 'conn-1',
    findings: [],
    gapsNotPursued: [],
    steeringNotes: [],
    roundsSpent: 0,
  })

  expect(mockSend).toHaveBeenCalledTimes(1)
  const call = mockSend.mock.calls[0][0]
  expect(call.kind).toBe('start')
  expect(call.input.name).toBe('run-1')
  expect(JSON.parse(call.input.input)).toEqual({
    chatId: 'chat-1',
    runId: 'run-1',
    sub: 'user-1',
    question: 'What is X?',
    connId: 'conn-1',
  })
})
