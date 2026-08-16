import { handler } from '../../src/research/recon'
import * as tools from '../../src/lib/tools'

jest.mock('../../src/lib/tools', () => ({
  executeTool: jest.fn(),
}))

const mockTools = tools as jest.Mocked<typeof tools>

beforeEach(() => jest.clearAllMocks())

test('recon handler — maps a successful web_search text result into notes', async () => {
  mockTools.executeTool.mockResolvedValue({
    entries: [{ kind: 'text', text: 'result summary' }],
    isError: false,
  })
  const result = await handler({ chatId: 'chat-1', runId: 'run-1', sub: 'user-1', question: 'what is X' })
  expect(result).toEqual({ notes: ['result summary'] })
  expect(mockTools.executeTool).toHaveBeenCalledWith('web_search', { query: 'what is X' }, { sub: 'user-1', chatId: 'chat-1' })
})

test('recon handler — an error ToolResult yields no notes rather than propagating', async () => {
  mockTools.executeTool.mockResolvedValue({ entries: [{ kind: 'text', text: 'search failed' }], isError: true })
  const result = await handler({ chatId: 'chat-1', runId: 'run-1', sub: 'user-1', question: 'what is X' })
  expect(result).toEqual({ notes: [] })
})
