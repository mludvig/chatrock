import { handler } from '../../src/research/fail'
import * as dynamo from '../../src/lib/dynamo'
import * as wsNotify from '../../src/lib/wsNotify'

jest.mock('../../src/lib/dynamo', () => ({
  ...jest.requireActual('../../src/lib/dynamo'),
  getRun: jest.fn(),
  updateRun: jest.fn(),
}))
jest.mock('../../src/lib/wsNotify', () => ({ notifyConnection: jest.fn() }))

const mockDynamo = dynamo as jest.Mocked<typeof dynamo>
const mockNotify = wsNotify as jest.Mocked<typeof wsNotify>

const run = (status: string) => ({ runId: 'r1', chatId: 'c1', status, connId: 'conn-1' } as never)

beforeEach(() => jest.clearAllMocks())

it('marks a live run failed and tells the connection on the row', async () => {
  mockDynamo.getRun.mockResolvedValue(run('running'))

  const res = await handler({ chatId: 'c1', runId: 'r1', error: { Error: 'Sandbox.Timedout', Cause: 'timed out' } })

  expect(res).toEqual({ failed: true })
  expect(mockDynamo.updateRun).toHaveBeenCalledWith('c1', 'r1', expect.objectContaining({ status: 'failed' }))
  expect(mockNotify.notifyConnection).toHaveBeenCalledWith('conn-1', expect.objectContaining({
    type: 'research_failed', runId: 'r1', chatId: 'c1',
  }))
})

// Report's Catch can fire after report.ts has already persisted the answer — overwriting
// 'done' would hide a report the user already has.
it('leaves an already-done run alone', async () => {
  mockDynamo.getRun.mockResolvedValue(run('done'))

  const res = await handler({ chatId: 'c1', runId: 'r1' })

  expect(res).toEqual({ failed: false })
  expect(mockDynamo.updateRun).not.toHaveBeenCalled()
  expect(mockNotify.notifyConnection).not.toHaveBeenCalled()
})

// The row is what unwedges the chat (getActiveRun stops treating it as active), so a row
// that can't be read must not stop the write.
it('still marks failed when the row cannot be read back', async () => {
  mockDynamo.getRun.mockResolvedValue(undefined as never)

  const res = await handler({ chatId: 'c1', runId: 'r1' })

  expect(res).toEqual({ failed: true })
  expect(mockDynamo.updateRun).toHaveBeenCalledWith('c1', 'r1', expect.objectContaining({ status: 'failed' }))
})
