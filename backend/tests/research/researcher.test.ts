import { handler } from '../../src/research/researcher'
import * as bedrock from '../../src/lib/bedrock'

jest.mock('../../src/lib/bedrock')

const mockBedrock = bedrock as jest.Mocked<typeof bedrock>

beforeEach(() => jest.clearAllMocks())

const BASE_INPUT = {
  chatId: 'chat-1',
  runId: 'run-1',
  sub: 'user-1',
  subQuestion: { id: 'sq1', question: 'What is the history of X?' },
  steeringNotes: [],
}

test('researcher handler — parses the final JSON turn into a Finding', async () => {
  async function* fakeStream() {
    yield { type: 'delta' as const, text: 'looking into it' }
    yield {
      type: 'turn' as const,
      role: 'assistant' as const,
      content: [{ kind: 'text' as const, text: JSON.stringify({ summary: 'X has a long history.', sourceUrls: ['https://example.com/x'] }) }],
      turnIndex: 0,
    }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  const result = await handler(BASE_INPUT)

  expect(result).toEqual({ finding: { subQuestionId: 'sq1', summary: 'X has a long history.', sourceUrls: ['https://example.com/x'] } })
})

test('researcher handler — malformed final JSON falls back to raw text with no sources', async () => {
  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ kind: 'text' as const, text: 'not json, just prose' }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  const result = await handler(BASE_INPUT)

  expect(result).toEqual({ finding: { subQuestionId: 'sq1', summary: 'not json, just prose', sourceUrls: [] } })
})

test('researcher handler — passes steering notes and sub-question into the user message', async () => {
  async function* fakeStream() {
    yield { type: 'turn' as const, role: 'assistant' as const, content: [{ kind: 'text' as const, text: JSON.stringify({ summary: 'done', sourceUrls: [] }) }], turnIndex: 0 }
    yield { type: 'stop' as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await handler({ ...BASE_INPUT, steeringNotes: ['Focus on recent developments only'] })

  const [, , messages] = mockBedrock.converseStream.mock.calls[0]
  const text = (messages[0].content[0] as { text: string }).text
  expect(text).toContain('What is the history of X?')
  expect(text).toContain('Focus on recent developments only')
})
