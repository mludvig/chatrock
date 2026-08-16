import { handler } from '../../src/research/plan'
import * as bedrock from '../../src/lib/bedrock'

jest.mock('../../src/lib/bedrock')

const mockBedrock = bedrock as jest.Mocked<typeof bedrock>

beforeEach(() => jest.clearAllMocks())

const BASE_INPUT = { chatId: 'chat-1', runId: 'run-1', sub: 'user-1', question: 'what is X', recon: { notes: ['note 1'] } }

test('plan handler — maps a valid response into subQuestions/clarifyingQuestions', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    clarifyingQuestions: ['Which X do you mean?'],
    subQuestions: [{ id: 'sq1', question: 'What is the history of X?' }, { id: 'sq2', question: 'What is the current state of X?' }],
  }))
  const result = await handler(BASE_INPUT)
  expect(result).toEqual({
    clarifyingQuestions: ['Which X do you mean?'],
    subQuestions: [{ id: 'sq1', question: 'What is the history of X?' }, { id: 'sq2', question: 'What is the current state of X?' }],
  })
})

test('plan handler — malformed JSON yields empty plan rather than throwing', async () => {
  mockBedrock.converseOnce.mockResolvedValue('not json')
  const result = await handler(BASE_INPUT)
  expect(result).toEqual({ subQuestions: [], clarifyingQuestions: [] })
})

test('plan handler — drops sub-questions with no question text', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    subQuestions: [{ id: 'sq1', question: 'Valid one' }, { id: 'sq2' }, { question: '' }],
  }))
  const result = await handler(BASE_INPUT)
  expect(result.subQuestions).toEqual([{ id: 'sq1', question: 'Valid one' }])
})

test('plan handler — de-duplicates a repeated or missing sub-question id', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    subQuestions: [{ id: 'sq1', question: 'First' }, { id: 'sq1', question: 'Second' }, { question: 'Third' }],
  }))
  const result = await handler(BASE_INPUT)
  const ids = result.subQuestions.map(sq => sq.id)
  expect(new Set(ids).size).toBe(3)
  expect(result.subQuestions.map(sq => sq.question)).toEqual(['First', 'Second', 'Third'])
})

test('plan handler — revise mode (priorPlan + feedback) sends the plan and feedback instead of recon notes', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    clarifyingQuestions: [],
    subQuestions: [{ id: 'sq1', question: 'Revised question?' }],
  }))
  const priorPlan = { subQuestions: [{ id: 'sq1', question: 'Original question?' }], clarifyingQuestions: [] }

  const result = await handler({
    chatId: 'chat-1', runId: 'run-1', sub: 'user-1', question: 'what is X',
    priorPlan, feedback: 'Change point 2 to XYZ',
  })

  expect(result.subQuestions).toEqual([{ id: 'sq1', question: 'Revised question?' }])
  const userMsg = (mockBedrock.converseOnce.mock.calls[0][2][0].content[0] as { text: string }).text
  expect(userMsg).toContain('CURRENT PLAN')
  expect(userMsg).toContain('Original question?')
  expect(userMsg).toContain('USER FEEDBACK ON THE PLAN: Change point 2 to XYZ')
  expect(userMsg).not.toContain('RECON NOTES')
})
