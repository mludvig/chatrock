import { handler } from '../../src/ws/researchApprove'
import * as dynamo from '../../src/lib/dynamo'
import { SFNClient } from '@aws-sdk/client-sfn'

jest.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  SendTaskSuccessCommand: jest.fn().mockImplementation(input => ({ input, kind: 'success' })),
}))

const mockSend = (SFNClient as jest.Mock).mock.results[0].value.send as jest.Mock

jest.mock('../../src/lib/dynamo', () => ({
  ...jest.requireActual('../../src/lib/dynamo'),
  getConnection: jest.fn(),
  getRun: jest.fn(),
  updateRun: jest.fn(),
}))

jest.mock('../../src/lib/wsNotify', () => ({ notifyConnection: jest.fn() }))

const mockDynamo = dynamo as jest.Mocked<typeof dynamo>

const makeEvent = (body: object, connId = 'conn-1') => ({
  requestContext: { connectionId: connId },
  body: JSON.stringify(body),
})

const BASE_RUN = {
  sub: 'user-1',
  status: 'awaiting_approval',
  question: 'what is X',
  plan: { subQuestions: [{ id: 'sq1', question: 'What is X?' }], clarifyingQuestions: [] },
  taskToken: 'token-abc',
}

beforeEach(() => jest.clearAllMocks())

test('returns 410 when the connection is gone', async () => {
  mockDynamo.getConnection.mockResolvedValue(undefined)
  const res = await handler(makeEvent({ chatId: 'chat-1', runId: 'run-1', decision: 'approve' }))
  expect((res as { statusCode: number }).statusCode).toBe(410)
})

test('returns 404 when the run belongs to a different user', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-2' })
  mockDynamo.getRun.mockResolvedValue(BASE_RUN)
  const res = await handler(makeEvent({ chatId: 'chat-1', runId: 'run-1', decision: 'approve' }))
  expect((res as { statusCode: number }).statusCode).toBe(404)
  expect(mockSend).not.toHaveBeenCalled()
})

test('returns 409 when the run is not awaiting approval', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1' })
  mockDynamo.getRun.mockResolvedValue({ ...BASE_RUN, status: 'running' })
  const res = await handler(makeEvent({ chatId: 'chat-1', runId: 'run-1', decision: 'approve' }))
  expect((res as { statusCode: number }).statusCode).toBe(409)
})

test('approve: sends SendTaskSuccess with the full reconstructed state and transitions to running', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1' })
  mockDynamo.getRun.mockResolvedValue(BASE_RUN)

  const res = await handler(makeEvent({ chatId: 'chat-1', runId: 'run-1', decision: 'approve' }))

  expect((res as { statusCode: number }).statusCode).toBe(200)
  expect(mockSend).toHaveBeenCalledTimes(1)
  const call = mockSend.mock.calls[0][0]
  expect(call.kind).toBe('success')
  expect(call.input.taskToken).toBe('token-abc')
  expect(JSON.parse(call.input.output)).toEqual({
    chatId: 'chat-1',
    runId: 'run-1',
    sub: 'user-1',
    question: 'what is X',
    plan: BASE_RUN.plan,
    findings: [],
    nextSubQuestions: BASE_RUN.plan.subQuestions,
    gapsNotPursued: [],
    steeringNotes: [],
    roundsSpent: 0,
    connId: 'conn-1',
  })
  expect(mockDynamo.updateRun).toHaveBeenCalledWith('chat-1', 'run-1', { status: 'running', plan: BASE_RUN.plan, connId: 'conn-1' })
})

test('approve with feedback: feedback seeds steeringNotes instead of triggering a replan', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1' })
  mockDynamo.getRun.mockResolvedValue(BASE_RUN)

  await handler(makeEvent({ chatId: 'chat-1', runId: 'run-1', decision: 'approve', feedback: '  Focus on 1990s  ' }))

  const call = mockSend.mock.calls[0][0]
  expect(JSON.parse(call.input.output).steeringNotes).toEqual(['Focus on 1990s'])
})

test('revise: sends SendTaskSuccess with revise:true and feedback, and leaves status awaiting_approval', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1' })
  mockDynamo.getRun.mockResolvedValue(BASE_RUN)

  const res = await handler(makeEvent({ chatId: 'chat-1', runId: 'run-1', decision: 'revise', feedback: 'Change point 2 to XYZ' }))

  expect((res as { statusCode: number }).statusCode).toBe(200)
  const call = mockSend.mock.calls[0][0]
  expect(call.kind).toBe('success')
  expect(JSON.parse(call.input.output)).toEqual({
    chatId: 'chat-1',
    runId: 'run-1',
    sub: 'user-1',
    question: 'what is X',
    plan: BASE_RUN.plan,
    feedback: 'Change point 2 to XYZ',
    revise: true,
    connId: 'conn-1',
  })
  expect(mockDynamo.updateRun).toHaveBeenCalledWith('chat-1', 'run-1', { connId: 'conn-1' })
})

test('revise without feedback returns 400 and sends nothing', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1' })
  mockDynamo.getRun.mockResolvedValue(BASE_RUN)

  const res = await handler(makeEvent({ chatId: 'chat-1', runId: 'run-1', decision: 'revise', feedback: '   ' }))

  expect((res as { statusCode: number }).statusCode).toBe(400)
  expect(mockSend).not.toHaveBeenCalled()
  expect(mockDynamo.updateRun).not.toHaveBeenCalled()
})
