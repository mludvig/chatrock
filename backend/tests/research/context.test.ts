import { buildRunContext, resolveRunContext, RUN_CONTEXT_CAP } from '../../src/research/context'
import * as dynamo from '../../src/lib/dynamo'

jest.mock('../../src/lib/dynamo', () => ({
  ...jest.requireActual('../../src/lib/dynamo'),
  listUserMemories: jest.fn(),
  getProject: jest.fn(),
  listProjectMemories: jest.fn(),
  getRun: jest.fn(),
}))

const mockDynamo = dynamo as jest.Mocked<typeof dynamo>

beforeEach(() => {
  jest.clearAllMocks()
  mockDynamo.listUserMemories.mockResolvedValue([])
  mockDynamo.getProject.mockResolvedValue(undefined)
  mockDynamo.listProjectMemories.mockResolvedValue([])
})

test('buildRunContext — renders user memories and skips the project reads for a non-project chat', async () => {
  mockDynamo.listUserMemories.mockResolvedValue([
    { text: 'Lives in New Zealand', category: 'identity' },
    { text: 'Self-employed contractor', category: 'identity' },
  ])

  const context = await buildRunContext('user-1')

  expect(context).toBe('What you know about the user:\n- Lives in New Zealand\n- Self-employed contractor')
  expect(mockDynamo.getProject).not.toHaveBeenCalled()
  expect(mockDynamo.listProjectMemories).not.toHaveBeenCalled()
})

test('buildRunContext — adds project instructions and project memories for a project chat', async () => {
  mockDynamo.listUserMemories.mockResolvedValue([{ text: 'Lives in New Zealand' }])
  mockDynamo.getProject.mockResolvedValue({ instructions: 'Answer in NZD.' })
  mockDynamo.listProjectMemories.mockResolvedValue([{ text: 'The client is a co-op' }])

  const context = await buildRunContext('user-1', 'proj-1')

  expect(context).toBe(
    'What you know about the user:\n- Lives in New Zealand\n\n' +
    'Project instructions:\nAnswer in NZD.\n\n' +
    'What you know about this project:\n- The client is a co-op'
  )
  expect(mockDynamo.getProject).toHaveBeenCalledWith('user-1', 'proj-1')
})

test('buildRunContext — returns undefined when there is nothing known', async () => {
  expect(await buildRunContext('user-1')).toBeUndefined()
})

test('buildRunContext — truncates an oversized memory store rather than sending it whole', async () => {
  mockDynamo.listUserMemories.mockResolvedValue(
    Array.from({ length: 200 }, (_, i) => ({ text: `fact ${i} ${'x'.repeat(80)}` }))
  )

  const context = await buildRunContext('user-1')

  expect(context!.length).toBeLessThanOrEqual(RUN_CONTEXT_CAP + 20)
  expect(context).toContain('(truncated)')
})

test('resolveRunContext — reads the snapshot off the RUN# row, undefined when absent or blank', async () => {
  mockDynamo.getRun.mockResolvedValue({ context: 'What you know about the user:\n- Lives in New Zealand' })
  expect(await resolveRunContext({ chatId: 'chat-1', runId: 'run-1', sub: 'user-1' }))
    .toBe('What you know about the user:\n- Lives in New Zealand')

  mockDynamo.getRun.mockResolvedValue({ context: '   ' })
  expect(await resolveRunContext({ chatId: 'chat-1', runId: 'run-1', sub: 'user-1' })).toBeUndefined()

  mockDynamo.getRun.mockResolvedValue(undefined)
  expect(await resolveRunContext({ chatId: 'chat-1', runId: 'run-1', sub: 'user-1' })).toBeUndefined()
})
