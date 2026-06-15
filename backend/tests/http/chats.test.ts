import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { handler } from '../../src/http/chats'
import * as dynamo from '../../src/lib/dynamo'
import * as attachmentsMod from '../../src/lib/attachments'

jest.mock('../../src/lib/dynamo')
jest.mock('../../src/lib/attachments', () => ({
  validateAttachment: jest.fn(),
  presignPut: jest.fn().mockResolvedValue('https://s3.example.com/presigned-put'),
  deleteChatObjects: jest.fn().mockResolvedValue(undefined),
  copyChatObjects: jest.fn().mockResolvedValue(new Map()),
  rewriteBlockUri: jest.fn((b: unknown) => b),
  s3KeyPrefix: jest.fn((sub: string, chatId: string) => `attachments/${sub}/${chatId}/`),
}))

const mockDynamo = dynamo as jest.Mocked<typeof dynamo>
const mockAttachments = attachmentsMod as jest.Mocked<typeof attachmentsMod>

// Helper: build a minimal turn row mock for listMessages responses
const makeRow = (msgId: string, parentId: string | null) => ({
  PK: 'CHAT#c1', SK: `MSG#2025-01-01T00:00:00.000Z#0000#${msgId}`,
  msgId, parentId, role: 'user', blocks: [{ text: 'x' }],
  model: 'm', createdAt: '2025-01-01T00:00:00.000Z', turnIndex: 0, responseId: 'r1',
})

beforeEach(() => jest.clearAllMocks())


const makeEvent = (
  method: string,
  path: string,
  body?: object,
  pathParams?: Record<string, string>,
) => ({
  requestContext: {
    authorizer: { jwt: { claims: { sub: 'user-1' } } },
  },
  routeKey: `${method} ${path}`,
  pathParameters: pathParams ?? {},
  body: body ? JSON.stringify(body) : undefined,
})

const result = (r: unknown) => r as APIGatewayProxyStructuredResultV2

test('GET /api/chats returns chat list', async () => {
  mockDynamo.listChats.mockResolvedValue([
    { PK: 'USER#user-1', SK: 'CHAT#c1', title: 'Hello', model: 'x', systemPrompt: '', createdAt: '', updatedAt: '' },
  ])
  const res = result(await handler(makeEvent('GET', '/api/chats') as any))
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body ?? '{}')
  expect(body.chats).toHaveLength(1)
  expect(body.chats[0].chatId).toBe('c1')
  expect(body.chats[0].title).toBe('Hello')
})

test('inc2: GET /api/chats includes activeLeafId in each chat', async () => {
  mockDynamo.listChats.mockResolvedValue([
    { PK: 'USER#user-1', SK: 'CHAT#c1', title: 'T', model: 'x', systemPrompt: '', createdAt: '', updatedAt: '', activeLeafId: 'leaf-abc' },
    { PK: 'USER#user-1', SK: 'CHAT#c2', title: 'T2', model: 'x', systemPrompt: '', createdAt: '', updatedAt: '' },
  ])
  const res = result(await handler(makeEvent('GET', '/api/chats') as any))
  const body = JSON.parse(res.body ?? '{}')
  expect(body.chats[0].activeLeafId).toBe('leaf-abc')
  expect(body.chats[1].activeLeafId).toBeUndefined()  // not set on a fresh chat
})

test('POST /api/chats creates a chat', async () => {
  mockDynamo.putChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('POST', '/api/chats', { model: 'global.anthropic.claude-sonnet-4-6', systemPrompt: '' }) as any))
  expect(res.statusCode).toBe(201)
  const body = JSON.parse(res.body ?? '{}')
  expect(typeof body.chatId).toBe('string')
  expect(mockDynamo.putChat).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'New Chat', model: 'global.anthropic.claude-sonnet-4-6' }),
  )
})

test('PATCH /api/chats/{chatId} renames a chat', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.updateChatTitle.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('PATCH', '/api/chats/{chatId}', { title: 'New Title' }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(200)
  expect(mockDynamo.updateChatTitle).toHaveBeenCalledWith('user-1', 'c1', 'New Title')
})

test('DELETE /api/chats/{chatId} deletes chat', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.deleteChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('DELETE', '/api/chats/{chatId}', undefined, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(204)
})

test('DELETE /api/chats/{chatId} returns 404 if not owned', async () => {
  mockDynamo.getChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('DELETE', '/api/chats/{chatId}', undefined, { chatId: 'other' }) as any))
  expect(res.statusCode).toBe(404)
})

test('PATCH /api/chats/{chatId} returns 404 if not owned', async () => {
  mockDynamo.getChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('PATCH', '/api/chats/{chatId}', { title: 'X' }, { chatId: 'other' }) as any))
  expect(res.statusCode).toBe(404)
})

test('GET /api/chats does not include CORS header (handled by API GW/CloudFront)', async () => {
  mockDynamo.listChats.mockResolvedValue([])
  const res = result(await handler(makeEvent('GET', '/api/chats') as any))
  expect((res.headers as Record<string, string>)['Access-Control-Allow-Origin']).toBeUndefined()
})

// ── Input validation: POST /api/chats ─────────────────────────────────────────

test('POST /api/chats with non-JSON body returns 400', async () => {
  const event = {
    requestContext: { authorizer: { jwt: { claims: { sub: 'user-1' } } } },
    routeKey: 'POST /api/chats',
    pathParameters: {},
    body: 'not json',
  }
  const res = result(await handler(event as any))
  expect(res.statusCode).toBe(400)
  expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: 'Invalid JSON body' })
})

test('POST /api/chats with template-injection body returns 400', async () => {
  const event = {
    requestContext: { authorizer: { jwt: { claims: { sub: 'user-1' } } } },
    routeKey: 'POST /api/chats',
    pathParameters: {},
    body: '{{7*7}}',
  }
  const res = result(await handler(event as any))
  expect(res.statusCode).toBe(400)
})

// ── Input validation: PATCH /api/chats/{chatId} ───────────────────────────────

test('PATCH /api/chats/{chatId} with numeric title returns 400', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  const event = {
    requestContext: { authorizer: { jwt: { claims: { sub: 'user-1' } } } },
    routeKey: 'PATCH /api/chats/{chatId}',
    pathParameters: { chatId: 'c1' },
    // Use raw JSON string to avoid JS number precision loss while still testing the type guard
    body: '{"title":99999999999999999999999999}',
  }
  const res = result(await handler(event as any))
  expect(res.statusCode).toBe(400)
  expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: 'title must be a string' })
})

test('PATCH /api/chats/{chatId} with array title returns 400', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  const event = {
    requestContext: { authorizer: { jwt: { claims: { sub: 'user-1' } } } },
    routeKey: 'PATCH /api/chats/{chatId}',
    pathParameters: { chatId: 'c1' },
    body: JSON.stringify({ title: [1, 2, 3] }),
  }
  const res = result(await handler(event as any))
  expect(res.statusCode).toBe(400)
})

test('PATCH /api/chats/{chatId} with non-JSON body returns 400', async () => {
  const event = {
    requestContext: { authorizer: { jwt: { claims: { sub: 'user-1' } } } },
    routeKey: 'PATCH /api/chats/{chatId}',
    pathParameters: { chatId: 'c1' },
    body: 'not json at all',
  }
  const res = result(await handler(event as any))
  expect(res.statusCode).toBe(400)
})

// ── Model allowlist validation ────────────────────────────────────────────────

test('POST /api/chats with unknown model returns 400', async () => {
  mockDynamo.putChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('POST', '/api/chats', { model: 'us.meta.llama3-3-70b-instruct-v1:0' }) as any))
  expect(res.statusCode).toBe(400)
  expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: 'Invalid model' })
})

test('POST /api/chats with valid model succeeds', async () => {
  mockDynamo.putChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('POST', '/api/chats', { model: 'global.anthropic.claude-sonnet-4-6' }) as any))
  expect(res.statusCode).toBe(201)
})

test('PATCH /api/chats/{chatId} with unknown model returns 400', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  const res = result(await handler(makeEvent('PATCH', '/api/chats/{chatId}', { model: 'COMPLETELY_FAKE_MODEL' }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(400)
  expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: 'Invalid model' })
})

test('PATCH /api/chats/{chatId} with valid model succeeds', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.updateChatModel.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('PATCH', '/api/chats/{chatId}', { model: 'global.anthropic.claude-opus-4-8' }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(200)
})

// ── Slice 3 (Inc 4): PATCH activeLeafId ──────────────────────────────────────

test('inc4: PATCH activeLeafId resolves leaf and updates chat', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.listMessages.mockResolvedValue([
    makeRow('u1', null),
    makeRow('asst-1', 'u1'),
  ])
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  const res = result(await handler(makeEvent('PATCH', '/api/chats/{chatId}', { activeLeafId: 'asst-1' }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(200)
  // resolveLeaf('asst-1') on a linear chain → 'asst-1' (it's already the leaf)
  expect(mockDynamo.updateChatActiveLeaf).toHaveBeenCalledWith('user-1', 'c1', 'asst-1')
})

test('inc4: PATCH activeLeafId resolves to deepest leaf when given an intermediate node', async () => {
  // Tree: u1 → asst-1 → u2 → asst-2; client sends asst-1 → server resolves to asst-2
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.listMessages.mockResolvedValue([
    makeRow('u1', null),
    makeRow('asst-1', 'u1'),
    makeRow('u2', 'asst-1'),
    makeRow('asst-2', 'u2'),
  ])
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  const res = result(await handler(makeEvent('PATCH', '/api/chats/{chatId}', { activeLeafId: 'asst-1' }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(200)
  expect(mockDynamo.updateChatActiveLeaf).toHaveBeenCalledWith('user-1', 'c1', 'asst-2')
})

test('inc4: PATCH activeLeafId with unknown msgId returns 400', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.listMessages.mockResolvedValue([makeRow('u1', null)])

  const res = result(await handler(makeEvent('PATCH', '/api/chats/{chatId}', { activeLeafId: 'nonexistent' }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(400)
  expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: 'Unknown activeLeafId' })
})

test('inc4: PATCH activeLeafId with non-string value returns 400', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })

  const res = result(await handler(makeEvent('PATCH', '/api/chats/{chatId}', { activeLeafId: 99 }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(400)
})

// ── Inc 6: POST /api/chats/{chatId}/fork ──────────────────────────────────────

// Helper: make a TurnRow with configurable role/responseId for fork tests
const makeForkRow = (
  msgId: string, parentId: string | null,
  overrides: { role?: 'user' | 'assistant'; responseId?: string; blocks?: unknown[] } = {}
) => ({
  PK: 'CHAT#c1', SK: `MSG#2025-01-01T00:00:00.000Z#0000#${msgId}`,
  msgId, parentId,
  role: overrides.role ?? 'assistant',
  blocks: overrides.blocks ?? [{ text: 'hello' }],
  model: 'model-x', createdAt: '2025-01-01T00:00:00.000Z',
  turnIndex: 0, responseId: overrides.responseId ?? 'r1',
})

test('inc6: fork on assistant bubble clones root→that bubble; 201 + new chatId', async () => {
  mockDynamo.getChat.mockResolvedValue({
    PK: 'USER#user-1', SK: 'CHAT#c1',
    title: 'My Chat', model: 'global.anthropic.claude-sonnet-4-6', systemPrompt: 'sys',
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
  })
  const rows = [
    makeForkRow('u1', null, { role: 'user', responseId: 'r1' }),
    makeForkRow('a1', 'u1', { role: 'assistant', responseId: 'r2' }),
  ]
  mockDynamo.listMessages.mockResolvedValue(rows)
  mockDynamo.putChat.mockResolvedValue(undefined)
  mockDynamo.batchPutMessages.mockResolvedValue(undefined)

  const res = result(await handler(makeEvent('POST', '/api/chats/{chatId}/fork', { fromMsgId: 'a1' }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(201)
  const body = JSON.parse(res.body ?? '{}')
  expect(typeof body.chatId).toBe('string')
  expect(body.chatId).not.toBe('c1')

  // putChat called with correct fork metadata
  expect(mockDynamo.putChat).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'My Chat (fork)', model: 'global.anthropic.claude-sonnet-4-6', systemPrompt: 'sys' })
  )
})

test('inc6: cloned rows have fresh msgIds and internally consistent parentId links', async () => {
  mockDynamo.getChat.mockResolvedValue({
    PK: 'USER#user-1', SK: 'CHAT#c1', title: 'T', model: 'global.anthropic.claude-sonnet-4-6',
    systemPrompt: '', createdAt: '', updatedAt: '',
  })
  const rows = [
    makeForkRow('u1', null, { role: 'user', responseId: 'r1' }),
    makeForkRow('a1', 'u1', { role: 'assistant', responseId: 'r2' }),
    makeForkRow('u2', 'a1', { role: 'user', responseId: 'r3' }),
    makeForkRow('a2', 'u2', { role: 'assistant', responseId: 'r4' }),
  ]
  mockDynamo.listMessages.mockResolvedValue(rows)
  mockDynamo.putChat.mockResolvedValue(undefined)
  mockDynamo.batchPutMessages.mockResolvedValue(undefined)

  await handler(makeEvent('POST', '/api/chats/{chatId}/fork', { fromMsgId: 'a2' }, { chatId: 'c1' }) as any)

  const cloned = mockDynamo.batchPutMessages.mock.calls[0][0] as Record<string, unknown>[]
  expect(cloned).toHaveLength(4)

  // No original msgId survives in the clone
  const origIds = new Set(['u1', 'a1', 'u2', 'a2'])
  for (const row of cloned) {
    expect(origIds.has(row.msgId as string)).toBe(false)
  }

  // parentId links are internally consistent: each non-root parentId maps to another cloned msgId
  const clonedIds = new Set(cloned.map(r => r.msgId as string))
  for (const row of cloned) {
    if (row.parentId !== null && row.parentId !== undefined) {
      expect(clonedIds.has(row.parentId as string)).toBe(true)
    }
  }
  // Root row has null parentId
  expect(cloned[0].parentId).toBeNull()
})

test('inc6: fork on multi-turn (tool-use) assistant includes whole response group', async () => {
  // a1(r2) → tr1(r2, toolResult user) → a2(r2) — same responseId, one "bubble"
  mockDynamo.getChat.mockResolvedValue({
    PK: 'USER#user-1', SK: 'CHAT#c1', title: 'T', model: 'global.anthropic.claude-sonnet-4-6',
    systemPrompt: '', createdAt: '', updatedAt: '',
  })
  const rows = [
    makeForkRow('u1', null, { role: 'user', responseId: 'r1' }),
    makeForkRow('a1', 'u1', { role: 'assistant', responseId: 'r2' }),
    makeForkRow('tr1', 'a1', { role: 'user', responseId: 'r2' }),    // tool result
    makeForkRow('a2', 'tr1', { role: 'assistant', responseId: 'r2' }),
  ]
  mockDynamo.listMessages.mockResolvedValue(rows)
  mockDynamo.putChat.mockResolvedValue(undefined)
  mockDynamo.batchPutMessages.mockResolvedValue(undefined)

  await handler(makeEvent('POST', '/api/chats/{chatId}/fork', { fromMsgId: 'a1' }, { chatId: 'c1' }) as any)

  // All 4 rows cloned (full response group included)
  const cloned = mockDynamo.batchPutMessages.mock.calls[0][0]
  expect(cloned).toHaveLength(4)
})

test('inc6: fork on user bubble clones up to its parent (user turn NOT included)', async () => {
  mockDynamo.getChat.mockResolvedValue({
    PK: 'USER#user-1', SK: 'CHAT#c1', title: 'T', model: 'global.anthropic.claude-sonnet-4-6',
    systemPrompt: '', createdAt: '', updatedAt: '',
  })
  // u1 → a1 → u2 → a2 — fork on u2 → should clone u1 + a1 only
  const rows = [
    makeForkRow('u1', null, { role: 'user', responseId: 'r1' }),
    makeForkRow('a1', 'u1', { role: 'assistant', responseId: 'r2' }),
    makeForkRow('u2', 'a1', { role: 'user', responseId: 'r3' }),
    makeForkRow('a2', 'u2', { role: 'assistant', responseId: 'r4' }),
  ]
  mockDynamo.listMessages.mockResolvedValue(rows)
  mockDynamo.putChat.mockResolvedValue(undefined)
  mockDynamo.batchPutMessages.mockResolvedValue(undefined)

  await handler(makeEvent('POST', '/api/chats/{chatId}/fork', { fromMsgId: 'u2' }, { chatId: 'c1' }) as any)

  const cloned = mockDynamo.batchPutMessages.mock.calls[0][0]
  expect(cloned).toHaveLength(2)  // u1 + a1 only
})

test('inc6: fork on root user bubble clones nothing; batchPutMessages not called', async () => {
  mockDynamo.getChat.mockResolvedValue({
    PK: 'USER#user-1', SK: 'CHAT#c1', title: 'T', model: 'global.anthropic.claude-sonnet-4-6',
    systemPrompt: '', createdAt: '', updatedAt: '',
  })
  const rows = [
    makeForkRow('u1', null, { role: 'user', responseId: 'r1' }),
    makeForkRow('a1', 'u1', { role: 'assistant', responseId: 'r2' }),
  ]
  mockDynamo.listMessages.mockResolvedValue(rows)
  mockDynamo.putChat.mockResolvedValue(undefined)
  mockDynamo.batchPutMessages.mockResolvedValue(undefined)

  const res = result(await handler(makeEvent('POST', '/api/chats/{chatId}/fork', { fromMsgId: 'u1' }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(201)
  expect(mockDynamo.batchPutMessages).not.toHaveBeenCalled()
  // putChat should not have activeLeafId set
  expect(mockDynamo.putChat).toHaveBeenCalledWith(
    expect.not.objectContaining({ activeLeafId: expect.anything() })
  )
})

test('inc6: fork returns 404 when chat not found', async () => {
  mockDynamo.getChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('POST', '/api/chats/{chatId}/fork', { fromMsgId: 'a1' }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(404)
})

test('inc6: fork returns 400 on unknown fromMsgId', async () => {
  mockDynamo.getChat.mockResolvedValue({
    PK: 'USER#user-1', SK: 'CHAT#c1', title: 'T', model: 'global.anthropic.claude-sonnet-4-6',
    systemPrompt: '', createdAt: '', updatedAt: '',
  })
  mockDynamo.listMessages.mockResolvedValue([
    makeForkRow('u1', null, { role: 'user', responseId: 'r1' }),
  ])
  const res = result(await handler(makeEvent('POST', '/api/chats/{chatId}/fork', { fromMsgId: 'nonexistent' }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(400)
  expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: 'Unknown fromMsgId' })
})

// ── Inc 7: DELETE /api/chats/{chatId}/messages/{msgId} ───────────────────────

test('inc7: delete branch removes node and all descendants; 204', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', activeLeafId: 'a2' })
  // u1 → a1 → u2 → a2; delete a1 → removes a1, u2, a2
  const rows = [
    makeRow('u1', null),
    makeRow('a1', 'u1'),
    makeRow('u2', 'a1'),
    makeRow('a2', 'u2'),
  ]
  mockDynamo.listMessages.mockResolvedValue(rows)
  mockDynamo.batchDeleteMessages.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  const res = result(await handler(makeEvent('DELETE', '/api/chats/{chatId}/messages/{msgId}', undefined, { chatId: 'c1', msgId: 'a1' }) as any))
  expect(res.statusCode).toBe(204)

  const deletedKeys = mockDynamo.batchDeleteMessages.mock.calls[0][0] as {PK: string; SK: string}[]
  const deletedSKs = deletedKeys.map(k => k.SK)
  // a1, u2, a2 must be deleted
  expect(deletedSKs.some(sk => sk.includes('a1'))).toBe(true)
  expect(deletedSKs.some(sk => sk.includes('u2'))).toBe(true)
  expect(deletedSKs.some(sk => sk.includes('a2'))).toBe(true)
  // u1 must NOT be deleted
  expect(deletedSKs.some(sk => sk.includes('u1'))).toBe(false)
})

test('inc7: delete branch resets activeLeafId to parentId when active leaf is in subtree', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', activeLeafId: 'a2' })
  // u1 → a1 → u2 → a2; delete a1; activeLeafId=a2 is in subtree → reset to u1
  const rows = [
    makeRow('u1', null),
    makeRow('a1', 'u1'),
    makeRow('u2', 'a1'),
    makeRow('a2', 'u2'),
  ]
  mockDynamo.listMessages.mockResolvedValue(rows)
  mockDynamo.batchDeleteMessages.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  await handler(makeEvent('DELETE', '/api/chats/{chatId}/messages/{msgId}', undefined, { chatId: 'c1', msgId: 'a1' }) as any)

  // activeLeafId should be reset to a1's parentId = u1
  expect(mockDynamo.updateChatActiveLeaf).toHaveBeenCalledWith('user-1', 'c1', 'u1')
})

test('inc7: delete branch leaves activeLeafId alone when active branch survives', async () => {
  // Two siblings: a1 (active) and a1b (to be deleted); activeLeafId=a1 is NOT in deleted subtree
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', activeLeafId: 'a1' })
  const rows = [
    makeRow('u1', null),
    makeRow('a1', 'u1'),
    makeRow('a1b', 'u1'),   // sibling, will be deleted
  ]
  mockDynamo.listMessages.mockResolvedValue(rows)
  mockDynamo.batchDeleteMessages.mockResolvedValue(undefined)
  mockDynamo.updateChatActiveLeaf.mockResolvedValue(undefined)

  await handler(makeEvent('DELETE', '/api/chats/{chatId}/messages/{msgId}', undefined, { chatId: 'c1', msgId: 'a1b' }) as any)

  expect(mockDynamo.updateChatActiveLeaf).not.toHaveBeenCalled()
})

test('inc7: delete branch returns 400 when deleting root (no parentId)', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  const rows = [makeRow('u1', null)]
  mockDynamo.listMessages.mockResolvedValue(rows)

  const res = result(await handler(makeEvent('DELETE', '/api/chats/{chatId}/messages/{msgId}', undefined, { chatId: 'c1', msgId: 'u1' }) as any))
  expect(res.statusCode).toBe(400)
  expect(mockDynamo.batchDeleteMessages).not.toHaveBeenCalled()
})

test('inc7: delete branch returns 404 when chat not found', async () => {
  mockDynamo.getChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('DELETE', '/api/chats/{chatId}/messages/{msgId}', undefined, { chatId: 'c1', msgId: 'a1' }) as any))
  expect(res.statusCode).toBe(404)
})

test('inc7: delete branch returns 404 when msgId not in chat', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  const rows = [makeRow('u1', null), makeRow('a1', 'u1')]
  mockDynamo.listMessages.mockResolvedValue(rows)

  const res = result(await handler(makeEvent('DELETE', '/api/chats/{chatId}/messages/{msgId}', undefined, { chatId: 'c1', msgId: 'nonexistent' }) as any))
  expect(res.statusCode).toBe(404)
})

// ── Upload route ──────────────────────────────────────────────────────────────

describe('POST /api/attachments', () => {
  test('returns s3Key and uploadUrl', async () => {
    mockAttachments.validateAttachment.mockReturnValue({ kind: 'image', format: 'png', maxBytes: 5 * 1024 * 1024 } as any)

    const res = result(await handler(makeEvent('POST', '/api/attachments', {
      chatId: 'chat-1',
      filename: 'screenshot.png',
      contentType: 'image/png',
      sizeBytes: 100_000,
    }) as any))

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body ?? '{}')
    expect(body.s3Key).toMatch(/^attachments\/user-1\/chat-1\//)
    expect(body.s3Key).toContain('screenshot.png')
    expect(body.uploadUrl).toBe('https://s3.example.com/presigned-put')
  })

  test('rejects invalid content type with 400', async () => {
    mockAttachments.validateAttachment.mockImplementation(() => { throw new Error('Content type not allowed') })

    const res = result(await handler(makeEvent('POST', '/api/attachments', {
      chatId: 'chat-1',
      filename: 'virus.exe',
      contentType: 'application/x-msdownload',
      sizeBytes: 100,
    }) as any))

    expect(res.statusCode).toBe(400)
  })

  test('rejects missing fields with 400', async () => {
    const res = result(await handler(makeEvent('POST', '/api/attachments', {
      chatId: 'chat-1',
      // missing filename, contentType, sizeBytes
    }) as any))

    expect(res.statusCode).toBe(400)
  })
})

// ── Delete calls deleteChatObjects ────────────────────────────────────────────

test('DELETE /api/chats/{chatId} calls deleteChatObjects after DDB delete', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.deleteChat.mockResolvedValue(undefined)
  mockAttachments.deleteChatObjects.mockResolvedValue(undefined)

  const res = result(await handler(makeEvent('DELETE', '/api/chats/{chatId}', undefined, { chatId: 'c1' }) as any))

  expect(res.statusCode).toBe(204)
  expect(mockAttachments.deleteChatObjects).toHaveBeenCalledWith('user-1', 'c1')
})

// ── Fork copies S3 objects ────────────────────────────────────────────────────

test('POST /api/chats/{chatId}/fork calls copyChatObjects', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', title: 'T', model: 'x', systemPrompt: '' })
  const rows = [
    { PK: 'CHAT#c1', SK: 'MSG#2024#0000#u1', msgId: 'u1', parentId: null, role: 'user', blocks: [{ text: 'hi' }], model: 'x', createdAt: '2024-01-01T00:00:00Z', turnIndex: 0, responseId: 'r1' },
  ]
  mockDynamo.listMessages.mockResolvedValue(rows as any)
  mockDynamo.putChat.mockResolvedValue(undefined)
  mockDynamo.batchPutMessages.mockResolvedValue(undefined)
  mockAttachments.copyChatObjects.mockResolvedValue(new Map())

  const res = result(await handler(makeEvent('POST', '/api/chats/{chatId}/fork', { fromMsgId: 'u1' }, { chatId: 'c1' }) as any))

  expect(res.statusCode).toBe(201)
  expect(mockAttachments.copyChatObjects).toHaveBeenCalledWith('user-1', 'c1', expect.any(String))
})

// ── Client-supplied chatId (new chat) ────────────────────────────────────────

test('POST /api/chats with valid client chatId uses that id', async () => {
  mockDynamo.putChat.mockResolvedValue(undefined)
  mockDynamo.getChat.mockResolvedValue(undefined)  // not a duplicate
  const clientId = '11111111-2222-3333-4444-555555555555'
  const res = result(await handler(makeEvent('POST', '/api/chats', {
    model: 'global.anthropic.claude-sonnet-4-6', systemPrompt: '', chatId: clientId,
  }) as any))
  expect(res.statusCode).toBe(201)
  const body = JSON.parse(res.body ?? '{}')
  expect(body.chatId).toBe(clientId)
  expect(mockDynamo.putChat).toHaveBeenCalledTimes(1)
  expect(mockDynamo.getChat).toHaveBeenCalledWith('user-1', clientId)
})

test('POST /api/chats with invalid chatId returns 400', async () => {
  const res = result(await handler(makeEvent('POST', '/api/chats', {
    model: 'global.anthropic.claude-sonnet-4-6', systemPrompt: '', chatId: 'not-a-uuid',
  }) as any))
  expect(res.statusCode).toBe(400)
  expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: 'Invalid chatId' })
})

test('POST /api/chats with duplicate chatId returns 409', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#existing' })
  const clientId = '11111111-2222-3333-4444-555555555555'
  const res = result(await handler(makeEvent('POST', '/api/chats', {
    model: 'global.anthropic.claude-sonnet-4-6', systemPrompt: '', chatId: clientId,
  }) as any))
  expect(res.statusCode).toBe(409)
  expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: 'Chat already exists' })
})

// ── Part B: modelSettings ─────────────────────────────────────────────────────

test('B1: PATCH modelSettings → updateChatModelSettings called', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  mockDynamo.updateChatModelSettings.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('PATCH', '/api/chats/{chatId}', { modelSettings: { webSearch: false, thinkingEffort: 'low' } }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(200)
  expect(mockDynamo.updateChatModelSettings).toHaveBeenCalledWith('user-1', 'c1', { webSearch: false, thinkingEffort: 'low' })
})

test('B2: PATCH modelSettings with non-object string → 400', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  const res = result(await handler(makeEvent('PATCH', '/api/chats/{chatId}', { modelSettings: 'bad' }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(400)
})

test('B3: PATCH modelSettings with array → 400', async () => {
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1' })
  const res = result(await handler(makeEvent('PATCH', '/api/chats/{chatId}', { modelSettings: [1, 2, 3] }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(400)
})

test('B4: GET /api/chats includes modelSettings when present on chat record', async () => {
  mockDynamo.listChats.mockResolvedValue([
    { PK: 'USER#user-1', SK: 'CHAT#c1', title: 'T', model: 'x', systemPrompt: '', createdAt: '', updatedAt: '', modelSettings: { webSearch: false } },
  ])
  const res = result(await handler(makeEvent('GET', '/api/chats') as any))
  const body = JSON.parse(res.body ?? '{}')
  expect(body.chats[0].modelSettings).toEqual({ webSearch: false })
})

test('B5: GET /api/chats omits modelSettings when absent', async () => {
  mockDynamo.listChats.mockResolvedValue([
    { PK: 'USER#user-1', SK: 'CHAT#c1', title: 'T', model: 'x', systemPrompt: '', createdAt: '', updatedAt: '' },
  ])
  const res = result(await handler(makeEvent('GET', '/api/chats') as any))
  const body = JSON.parse(res.body ?? '{}')
  expect(body.chats[0].modelSettings).toBeUndefined()
})

test('B6: POST /api/chats with modelSettings persists it', async () => {
  mockDynamo.putChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('POST', '/api/chats', { model: 'global.anthropic.claude-sonnet-4-6', modelSettings: { webSearch: false } }) as any))
  expect(res.statusCode).toBe(201)
  expect(mockDynamo.putChat).toHaveBeenCalledWith(
    expect.objectContaining({ modelSettings: { webSearch: false } })
  )
})

test('B7: fork carries modelSettings from source chat', async () => {
  mockDynamo.getChat.mockResolvedValue({
    PK: 'USER#user-1', SK: 'CHAT#c1', title: 'My Chat', model: 'global.anthropic.claude-sonnet-4-6',
    systemPrompt: 'sys', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    modelSettings: { webSearch: false },
  })
  const rows = [
    makeForkRow('u1', null, { role: 'user', responseId: 'r1' }),
    makeForkRow('a1', 'u1', { role: 'assistant', responseId: 'r2' }),
  ]
  mockDynamo.listMessages.mockResolvedValue(rows)
  mockDynamo.putChat.mockResolvedValue(undefined)
  mockDynamo.batchPutMessages.mockResolvedValue(undefined)

  const res = result(await handler(makeEvent('POST', '/api/chats/{chatId}/fork', { fromMsgId: 'a1' }, { chatId: 'c1' }) as any))
  expect(res.statusCode).toBe(201)
  expect(mockDynamo.putChat).toHaveBeenCalledWith(
    expect.objectContaining({ modelSettings: { webSearch: false } })
  )
})

test('B8: fork without modelSettings does not set it on fork', async () => {
  mockDynamo.getChat.mockResolvedValue({
    PK: 'USER#user-1', SK: 'CHAT#c1', title: 'My Chat', model: 'global.anthropic.claude-sonnet-4-6',
    systemPrompt: '', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    // no modelSettings
  })
  const rows = [
    makeForkRow('u1', null, { role: 'user', responseId: 'r1' }),
    makeForkRow('a1', 'u1', { role: 'assistant', responseId: 'r2' }),
  ]
  mockDynamo.listMessages.mockResolvedValue(rows)
  mockDynamo.putChat.mockResolvedValue(undefined)
  mockDynamo.batchPutMessages.mockResolvedValue(undefined)

  await handler(makeEvent('POST', '/api/chats/{chatId}/fork', { fromMsgId: 'a1' }, { chatId: 'c1' }) as any)
  expect(mockDynamo.putChat).toHaveBeenCalledWith(
    expect.not.objectContaining({ modelSettings: expect.anything() })
  )
})

test('inc6: original chat rows are not modified (no writes to original CHAT#c1 partition)', async () => {
  mockDynamo.getChat.mockResolvedValue({
    PK: 'USER#user-1', SK: 'CHAT#c1', title: 'T', model: 'global.anthropic.claude-sonnet-4-6',
    systemPrompt: '', createdAt: '', updatedAt: '',
  })
  const rows = [
    makeForkRow('u1', null, { role: 'user', responseId: 'r1' }),
    makeForkRow('a1', 'u1', { role: 'assistant', responseId: 'r2' }),
  ]
  mockDynamo.listMessages.mockResolvedValue(rows)
  mockDynamo.putChat.mockResolvedValue(undefined)
  mockDynamo.batchPutMessages.mockResolvedValue(undefined)

  await handler(makeEvent('POST', '/api/chats/{chatId}/fork', { fromMsgId: 'a1' }, { chatId: 'c1' }) as any)

  // All cloned rows must have PK pointing to the NEW chat, not 'CHAT#c1'
  const cloned = mockDynamo.batchPutMessages.mock.calls[0][0]
  for (const row of cloned) {
    expect(row.PK).not.toBe('CHAT#c1')
  }
})
