import { handler } from '../../src/research/assess'
import * as bedrock from '../../src/lib/bedrock'
import * as dynamo from '../../src/lib/dynamo'

jest.mock('../../src/lib/bedrock')
jest.mock('../../src/lib/dynamo', () => ({ updateRun: jest.fn() }))
jest.mock('../../src/lib/wsNotify', () => ({ notifyConnection: jest.fn() }))

const mockBedrock = bedrock as jest.Mocked<typeof bedrock>
const mockDynamo = dynamo as jest.Mocked<typeof dynamo>

beforeEach(() => jest.clearAllMocks())

const BASE_INPUT = {
  chatId: 'chat-1',
  runId: 'run-1',
  sub: 'user-1',
  connId: 'conn-1',
  question: 'What is the history of X?',
  plan: { subQuestions: [{ id: 'sq1', question: 'Origins of X?' }], clarifyingQuestions: [] },
  findings: [] as { subQuestionId: string; summary: string; sourceUrls: string[] }[],
  waveFindings: [
    {
      subQuestion: { id: 'sq1', question: 'Origins of X?' },
      steeringNotes: [],
      result: { finding: { subQuestionId: 'sq1', summary: 'X originated in Y.', sourceUrls: ['https://example.com'] } },
    },
  ],
  gapsNotPursued: [],
  steeringNotes: [],
  roundsSpent: 0,
}

test('assess handler — merges wave findings into the running total and reports done', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ done: true, nextSubQuestions: [], gapsNotPursued: [] }))

  const result = await handler(BASE_INPUT)

  expect(result).toEqual({
    chatId: 'chat-1',
    runId: 'run-1',
    sub: 'user-1',
    question: 'What is the history of X?',
    plan: BASE_INPUT.plan,
    findings: [{ subQuestionId: 'sq1', summary: 'X originated in Y.', sourceUrls: ['https://example.com'] }],
    nextSubQuestions: [],
    gapsNotPursued: [],
    steeringNotes: [],
    roundsSpent: 1,
    done: true,
    connId: 'conn-1',
  })
  expect(mockDynamo.updateRun).toHaveBeenCalledWith('chat-1', 'run-1', {
    findings: [{ subQuestionId: 'sq1', summary: 'X originated in Y.', sourceUrls: ['https://example.com'] }],
    gapsNotPursued: [],
    roundsSpent: 1,
  })
})

test('assess handler — not done: returns fresh sub-questions and clears steering notes', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    done: false,
    nextSubQuestions: [{ id: 'sq2', question: 'What happened after Y?' }],
    gapsNotPursued: ['Did not verify the exact date'],
  }))

  const result = await handler({ ...BASE_INPUT, steeringNotes: ['Focus on the 1990s'] })

  expect(result.done).toBe(false)
  expect(result.nextSubQuestions).toEqual([{ id: 'sq2', question: 'What happened after Y?' }])
  expect(result.gapsNotPursued).toEqual(['Did not verify the exact date'])
  expect(result.steeringNotes).toEqual([])
  expect(result.roundsSpent).toBe(1)
})

test('assess handler — accumulates gapsNotPursued across rounds rather than replacing it', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ done: true, nextSubQuestions: [], gapsNotPursued: ['New gap'] }))

  const result = await handler({ ...BASE_INPUT, gapsNotPursued: ['Old gap'] })

  expect(result.gapsNotPursued).toEqual(['Old gap', 'New gap'])
})

test('assess handler — treats empty nextSubQuestions as done even if the model said false', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ done: false, nextSubQuestions: [], gapsNotPursued: [] }))

  const result = await handler(BASE_INPUT)

  expect(result.done).toBe(true)
})

test('assess handler — malformed JSON falls back to done:true with no new sub-questions', async () => {
  mockBedrock.converseOnce.mockResolvedValue('not json at all')

  const result = await handler(BASE_INPUT)

  expect(result.done).toBe(true)
  expect(result.nextSubQuestions).toEqual([])
  expect(result.roundsSpent).toBe(1)
})
