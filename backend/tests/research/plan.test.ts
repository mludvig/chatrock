import { handler } from '../../src/research/plan'
import * as bedrock from '../../src/lib/bedrock'

jest.mock('../../src/lib/bedrock')
jest.mock('../../src/research/model', () => ({ resolveRunModel: jest.fn().mockResolvedValue('test-model') }))
jest.mock('../../src/research/context', () => ({ resolveRunContext: jest.fn(), resolveRunProjectContext: jest.fn() }))
jest.mock('../../src/research/attachments', () => ({ resolveRunAttachmentBlocks: jest.fn().mockResolvedValue([]) }))

const mockBedrock = bedrock as jest.Mocked<typeof bedrock>
const mockResolveRunContext = jest.requireMock('../../src/research/context').resolveRunContext as jest.Mock
const mockResolveRunProjectContext = jest.requireMock('../../src/research/context').resolveRunProjectContext as jest.Mock
const mockResolveRunAttachmentBlocks = jest.requireMock('../../src/research/attachments').resolveRunAttachmentBlocks as jest.Mock

const sentUserMsg = () => (mockBedrock.converseOnce.mock.calls[0][2][0].content[0] as { text: string }).text

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
  const userMsg = sentUserMsg()
  expect(userMsg).toContain('CURRENT PLAN')
  expect(userMsg).toContain('Original question?')
  expect(userMsg).toContain('USER FEEDBACK ON THE PLAN: Change point 2 to XYZ')
  expect(userMsg).not.toContain('RECON NOTES')
})

test('plan handler — prepends the run context so the planner can answer its own clarifying questions', async () => {
  mockResolveRunContext.mockResolvedValue('What you know about the user:\n- Lives in New Zealand')
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    clarifyingQuestions: [], subQuestions: [{ id: 'sq1', question: 'X in New Zealand?' }],
  }))

  await handler(BASE_INPUT)

  const userMsg = sentUserMsg()
  expect(userMsg).toContain('ABOUT THE USER:\nWhat you know about the user:\n- Lives in New Zealand')
  expect(userMsg.indexOf('ABOUT THE USER:')).toBeLessThan(userMsg.indexOf('QUESTION:'))
})

test('plan handler — revise mode gets the same context block', async () => {
  mockResolveRunContext.mockResolvedValue('What you know about the user:\n- Lives in New Zealand')
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    clarifyingQuestions: [], subQuestions: [{ id: 'sq1', question: 'Revised?' }],
  }))

  await handler({
    chatId: 'chat-1', runId: 'run-1', sub: 'user-1', question: 'what is X',
    priorPlan: { subQuestions: [{ id: 'sq1', question: 'Original?' }], clarifyingQuestions: [] },
    feedback: 'change it',
  })

  const userMsg = sentUserMsg()
  expect(userMsg).toContain('ABOUT THE USER:')
  expect(userMsg).toContain('USER FEEDBACK ON THE PLAN: change it')
})

test('plan handler — no context block when the run has none', async () => {
  mockResolveRunContext.mockResolvedValue(undefined)
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ subQuestions: [{ id: 'sq1', question: 'X?' }] }))

  await handler(BASE_INPUT)

  expect(sentUserMsg().startsWith('QUESTION: what is X')).toBe(true)
})

test('plan handler — prepends the project file snapshot so a sub-question can reference a file', async () => {
  mockResolveRunProjectContext.mockResolvedValue('Project files (labels only...):\n- [f1] spec.md — the spec')
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    clarifyingQuestions: [], subQuestions: [{ id: 'sq1', question: 'What does spec.md say about X?' }],
  }))

  await handler(BASE_INPUT)

  const userMsg = sentUserMsg()
  expect(userMsg).toContain('PROJECT FILES:\nProject files (labels only...):\n- [f1] spec.md — the spec')
  expect(userMsg.indexOf('PROJECT FILES:')).toBeLessThan(userMsg.indexOf('QUESTION:'))
})

test('plan handler — prepends the question\'s attachment blocks ahead of the text block', async () => {
  const imageBlock = { kind: 'image', image: { format: 'png', source: { bytes: new Uint8Array([1]) } } }
  mockResolveRunAttachmentBlocks.mockResolvedValue([imageBlock])
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ subQuestions: [{ id: 'sq1', question: 'X?' }] }))

  await handler(BASE_INPUT)

  const content = mockBedrock.converseOnce.mock.calls[0][2][0].content
  expect(content[0]).toEqual(imageBlock)
  expect(content[1]).toMatchObject({ kind: 'text' })
})
