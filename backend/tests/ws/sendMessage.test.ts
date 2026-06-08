import { buildHandler } from '../../src/ws/sendMessage'
import * as dynamo from '../../src/lib/dynamo'
import * as bedrock from '../../src/lib/bedrock'

jest.mock('../../src/lib/dynamo')
jest.mock('../../src/lib/bedrock')

const mockDynamo  = dynamo  as jest.Mocked<typeof dynamo>
const mockBedrock = bedrock as jest.Mocked<typeof bedrock>

const mockPost = jest.fn().mockResolvedValue(undefined)

const makeEvent = (body: object) => ({
  requestContext: {
    connectionId: 'conn-1',
    domainName: 'x.execute-api.ap-southeast-2.amazonaws.com',
    stage: 'prod',
  },
  body: JSON.stringify(body),
})

beforeEach(() => {
  jest.clearAllMocks()
  mockPost.mockResolvedValue(undefined)
})

test('streams tokens and persists user + assistant messages', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: 'x', systemPrompt: '', title: 'New Chat' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatTitle.mockResolvedValue(undefined)

  async function* fakeStream() {
    yield { type: 'delta' as const, text: 'Hello' }
    yield { type: 'delta' as const, text: ' world' }
    yield { type: 'stop'  as const, stopReason: 'end_turn' }
  }
  mockBedrock.converseStream.mockReturnValue(fakeStream())
  mockBedrock.converseOnce.mockResolvedValue('Test Title')

  const handler = buildHandler(mockPost)
  await handler(makeEvent({ chatId: 'c1', content: 'Hi', model: 'x', systemPrompt: '' }))

  // Two delta posts + one done post
  const dataPayloads = mockPost.mock.calls.map(c => JSON.parse(c[0].Data))
  expect(dataPayloads.filter((d: {type: string}) => d.type === 'delta')).toHaveLength(2)
  expect(dataPayloads.find((d: {type: string}) => d.type === 'done')).toBeDefined()

  // User message + assistant message persisted
  expect(mockDynamo.putMessage).toHaveBeenCalledTimes(2)
  expect(mockDynamo.putMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', content: 'Hi' }))
  expect(mockDynamo.putMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'assistant', content: 'Hello world' }))
})

test('sends titleUpdated event on first exchange', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: 'x', systemPrompt: '', title: 'New Chat' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)
  mockDynamo.updateChatTitle.mockResolvedValue(undefined)

  async function* fakeStream() { yield { type: 'stop' as const, stopReason: 'end_turn' } }
  mockBedrock.converseStream.mockReturnValue(fakeStream())
  mockBedrock.converseOnce.mockResolvedValue('My Title')

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Hello', model: 'x', systemPrompt: '' }))

  const titleEvent = mockPost.mock.calls.map(c => JSON.parse(c[0].Data)).find((d: {type:string}) => d.type === 'titleUpdated')
  expect(titleEvent).toMatchObject({ type: 'titleUpdated', title: 'My Title', chatId: 'c1' })
  expect(mockDynamo.updateChatTitle).toHaveBeenCalledWith('user-1', 'c1', 'My Title')
})

test('does not re-title when chat already has a title', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', model: 'x', systemPrompt: '', title: 'Existing Title' })
  mockDynamo.listMessages.mockResolvedValue([])
  mockDynamo.putMessage.mockResolvedValue(undefined)

  async function* fakeStream() { yield { type: 'stop' as const, stopReason: 'end_turn' } }
  mockBedrock.converseStream.mockReturnValue(fakeStream())

  await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Hello', model: 'x', systemPrompt: '' }))

  expect(mockDynamo.updateChatTitle).not.toHaveBeenCalled()
  expect(mockBedrock.converseOnce).not.toHaveBeenCalled()
})

test('returns 410 when connection not found', async () => {
  mockDynamo.getConnection.mockResolvedValue(undefined)
  const res = await buildHandler(mockPost)(makeEvent({ chatId: 'c1', content: 'Hi', model: 'x', systemPrompt: '' })) as any
  expect(res.statusCode).toBe(410)
})

test('sends error event when chat not found', async () => {
  mockDynamo.getConnection.mockResolvedValue({ userSub: 'user-1', connectedAt: '' })
  mockDynamo.getChat.mockResolvedValue(undefined)

  await buildHandler(mockPost)(makeEvent({ chatId: 'missing', content: 'Hi', model: 'x', systemPrompt: '' }))

  const errEvent = mockPost.mock.calls.map(c => JSON.parse(c[0].Data)).find((d: {type:string}) => d.type === 'error')
  expect(errEvent).toBeDefined()
  expect(mockDynamo.putMessage).not.toHaveBeenCalled()
})
