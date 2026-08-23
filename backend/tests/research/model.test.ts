import { resolveRunModel } from '../../src/research/model'
import * as dynamo from '../../src/lib/dynamo'
import { DEFAULT_CHAT_MODEL } from '../../src/config/models'

jest.mock('../../src/lib/dynamo', () => ({ getRun: jest.fn() }))

const mockDynamo = dynamo as jest.Mocked<typeof dynamo>
const EVENT = { chatId: 'chat-1', runId: 'run-1', sub: 'user-1' }

beforeEach(() => jest.clearAllMocks())

test('resolveRunModel — returns the model snapshotted on the RUN# row', async () => {
  mockDynamo.getRun.mockResolvedValue({ model: 'global.anthropic.claude-opus-5' })
  await expect(resolveRunModel(EVENT)).resolves.toBe('global.anthropic.claude-opus-5')
})

test('resolveRunModel — falls back to the default for a run started before the field existed', async () => {
  mockDynamo.getRun.mockResolvedValue({ runId: 'run-1' })
  await expect(resolveRunModel(EVENT)).resolves.toBe(DEFAULT_CHAT_MODEL)
})

test('resolveRunModel — falls back to the default for a model id retired from the registry', async () => {
  mockDynamo.getRun.mockResolvedValue({ model: 'global.anthropic.claude-sonnet-4-6' })
  await expect(resolveRunModel(EVENT)).resolves.toBe(DEFAULT_CHAT_MODEL)
})
