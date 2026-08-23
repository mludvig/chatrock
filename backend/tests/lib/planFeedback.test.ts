import { classifyPlanFeedback } from '../../src/lib/planFeedback'
import * as bedrock from '../../src/lib/bedrock'

jest.mock('../../src/lib/bedrock', () => ({ converseOnce: jest.fn() }))
const mockBedrock = bedrock as jest.Mocked<typeof bedrock>

const PLAN = {
  subQuestions: [{ id: 'sq1', question: 'What changed in 1995?' }],
  clarifyingQuestions: ['Which region?'],
}
const CTX = { sub: 'user-1', chatId: 'c1', runId: 'run-1' }

beforeEach(() => jest.clearAllMocks())

test.each([
  ['APPROVE', 'approve'],
  ['STEER', 'approve_with_steering'],
  ['REVISE', 'revise'],
])('%s maps to %s', async (verdict, expected) => {
  mockBedrock.converseOnce.mockResolvedValue(`${verdict}\n`)
  expect(await classifyPlanFeedback('whatever', PLAN, CTX)).toBe(expected)
})

test('the plan is shown to the classifier numbered as the user saw it', async () => {
  mockBedrock.converseOnce.mockResolvedValue('APPROVE')

  await classifyPlanFeedback('ok', PLAN, CTX)

  const text = (mockBedrock.converseOnce.mock.calls[0][2][0].content[0] as { text: string }).text
  expect(text).toContain('1. Which region?')
  expect(text).toContain('1. What changed in 1995?')
  expect(text).toContain('USER REPLY:\nok')
})

test('an unparseable verdict falls back to revise', async () => {
  mockBedrock.converseOnce.mockResolvedValue('I think you should')
  expect(await classifyPlanFeedback('hmm', PLAN, CTX)).toBe('revise')
})

test('a failed call falls back to revise rather than starting a wave on a misread reply', async () => {
  mockBedrock.converseOnce.mockRejectedValue(new Error('throttled'))
  expect(await classifyPlanFeedback('also cover Europe', PLAN, CTX)).toBe('revise')
})
