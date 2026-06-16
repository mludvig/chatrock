import { enrichTurn, enrichChatForProject } from '../../src/lib/enrichment'
import * as bedrock from '../../src/lib/bedrock'
import * as dynamo from '../../src/lib/dynamo'
import * as treeLib from '../../src/lib/tree'

jest.mock('../../src/lib/bedrock')
jest.mock('../../src/lib/dynamo', () => ({
  ...jest.requireActual('../../src/lib/dynamo'),
  listMessages: jest.fn(),
  updateChatSummary: jest.fn(),
}))
jest.mock('../../src/lib/tree', () => ({
  ...jest.requireActual('../../src/lib/tree'),
  buildActivePath: jest.fn(),
}))

const mockBedrock = bedrock as jest.Mocked<typeof bedrock>
const mockDynamo = dynamo as jest.Mocked<typeof dynamo>
const mockTree = treeLib as jest.Mocked<typeof treeLib>

beforeEach(() => jest.clearAllMocks())

const TRANSCRIPT = 'User: Hi, I am Alice from Wellington.\nAssistant: Nice to meet you!'

test('isProject:false — returns userFacts only, no projectFacts or summary', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    userFacts: [{ category: 'identity', text: 'User is Alice from Wellington' }],
  }))
  const result = await enrichTurn({ transcript: TRANSCRIPT, isProject: false, needTitle: false })
  expect(result.userFacts).toHaveLength(1)
  expect(result.userFacts[0].text).toBe('User is Alice from Wellington')
  expect(result.projectFacts).toBeUndefined()
  expect(result.summary).toBeUndefined()
  expect(result.title).toBeUndefined()
})

test('isProject:true — returns projectFacts and summary', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    userFacts: [],
    projectFacts: [{ category: 'decision', text: 'Deploy via ./deploy.sh' }],
    summary: 'Chat about the deployment pipeline.',
  }))
  const result = await enrichTurn({ transcript: TRANSCRIPT, isProject: true, needTitle: false })
  expect(result.projectFacts).toHaveLength(1)
  expect(result.projectFacts![0].category).toBe('decision')
  expect(result.summary).toBe('Chat about the deployment pipeline.')
})

test('needTitle:true — returns title field', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    userFacts: [],
    title: 'Deployment setup',
  }))
  const result = await enrichTurn({ transcript: TRANSCRIPT, isProject: false, needTitle: true })
  expect(result.title).toBe('Deployment setup')
})

test('malformed model output — returns empty defaults, never throws', async () => {
  mockBedrock.converseOnce.mockResolvedValue('not json')
  const result = await enrichTurn({ transcript: TRANSCRIPT, isProject: true, needTitle: true })
  expect(result.userFacts).toEqual([])
  expect(result.projectFacts).toBeUndefined()
  expect(result.summary).toBeUndefined()
  expect(result.title).toBeUndefined()
})

test('bedrock throws — returns empty defaults, never throws', async () => {
  mockBedrock.converseOnce.mockRejectedValue(new Error('network'))
  await expect(enrichTurn({ transcript: TRANSCRIPT, isProject: false, needTitle: false }))
    .resolves.toEqual({ userFacts: [] })
})

test('strips markdown code fences from model output', async () => {
  mockBedrock.converseOnce.mockResolvedValue('```json\n{"userFacts":[{"category":"identity","text":"Alice"}]}\n```')
  const result = await enrichTurn({ transcript: TRANSCRIPT, isProject: false, needTitle: false })
  expect(result.userFacts).toHaveLength(1)
})

test('isProject:true but projectFacts missing from output — defaults to []', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ userFacts: [] }))
  const result = await enrichTurn({ transcript: TRANSCRIPT, isProject: true, needTitle: false })
  expect(result.projectFacts).toEqual([])
  expect(result.summary).toBeUndefined()
})

test('invalid category values are filtered out', async () => {
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    userFacts: [
      { category: 'identity', text: 'Valid fact' },
      { category: 'invalid', text: 'Bad category' },
    ],
  }))
  const result = await enrichTurn({ transcript: TRANSCRIPT, isProject: false, needTitle: false })
  expect(result.userFacts).toHaveLength(1)
  expect(result.userFacts[0].text).toBe('Valid fact')
})

test('system prompt includes project section only when isProject:true', async () => {
  mockBedrock.converseOnce.mockResolvedValue('{}')
  await enrichTurn({ transcript: TRANSCRIPT, isProject: true, needTitle: false })
  const callArgs = mockBedrock.converseOnce.mock.calls[0]
  expect(callArgs[1]).toContain('projectFacts')
  expect(callArgs[1]).toContain('summary')
})

test('system prompt does not include project section when isProject:false', async () => {
  mockBedrock.converseOnce.mockResolvedValue('{}')
  await enrichTurn({ transcript: TRANSCRIPT, isProject: false, needTitle: false })
  const callArgs = mockBedrock.converseOnce.mock.calls[0]
  expect(callArgs[1]).not.toContain('projectFacts')
})

// ── enrichChatForProject ──────────────────────────────────────────────────────

const FAKE_ROWS = [
  { msgId: 'm1', parentId: null, role: 'user', blocks: [{ text: 'Hello project' }] },
  { msgId: 'm2', parentId: 'm1', role: 'assistant', blocks: [{ text: 'Hi from the project' }] },
]

test('enrichChatForProject — calls updateChatSummary when summary is returned', async () => {
  mockDynamo.listMessages.mockResolvedValue(FAKE_ROWS as unknown as Record<string, unknown>[])
  mockTree.buildActivePath.mockReturnValue(FAKE_ROWS as any)
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    userFacts: [],
    projectFacts: [],
    summary: 'A project chat about greetings.',
  }))
  mockDynamo.updateChatSummary.mockResolvedValue(undefined)

  const result = await enrichChatForProject('user-1', 'chat-1')

  expect(result).toBe('A project chat about greetings.')
  expect(mockDynamo.updateChatSummary).toHaveBeenCalledWith('user-1', 'chat-1', 'A project chat about greetings.')
})

test('enrichChatForProject — no updateChatSummary when enrichTurn returns no summary', async () => {
  mockDynamo.listMessages.mockResolvedValue(FAKE_ROWS as unknown as Record<string, unknown>[])
  mockTree.buildActivePath.mockReturnValue(FAKE_ROWS as any)
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ userFacts: [] }))

  const result = await enrichChatForProject('user-1', 'chat-1')

  expect(result).toBeUndefined()
  expect(mockDynamo.updateChatSummary).not.toHaveBeenCalled()
})

test('enrichChatForProject — returns undefined when chat has no messages (never throws)', async () => {
  mockDynamo.listMessages.mockResolvedValue([])

  const result = await enrichChatForProject('user-1', 'empty-chat')

  expect(result).toBeUndefined()
  expect(mockDynamo.updateChatSummary).not.toHaveBeenCalled()
})

test('enrichChatForProject — returns undefined on error (never throws)', async () => {
  mockDynamo.listMessages.mockRejectedValue(new Error('DB error'))

  const result = await enrichChatForProject('user-1', 'chat-1')

  expect(result).toBeUndefined()
})
