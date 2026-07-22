import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { handler } from '../../src/http/share'
import * as dynamo from '../../src/lib/dynamo'
import * as attachmentsMod from '../../src/lib/attachments'

jest.mock('../../src/lib/dynamo')
jest.mock('../../src/lib/attachments', () => ({
  signCloudFrontUrl: jest.fn().mockResolvedValue('https://cdn.example.com/signed'),
}))

const mockDynamo = dynamo as jest.Mocked<typeof dynamo>
void (attachmentsMod as jest.Mocked<typeof attachmentsMod>)

beforeEach(() => jest.clearAllMocks())

const result = (r: unknown) => r as APIGatewayProxyStructuredResultV2

const makeEvent = (shareId: string, opts?: { format?: string; accept?: string }) => ({
  pathParameters: { shareId },
  queryStringParameters: opts?.format ? { format: opts.format } : {},
  headers: opts?.accept ? { accept: opts.accept } : {},
})

const row = (msgId: string, parentId: string | null, role: 'user' | 'assistant', blocks: unknown[]) => ({
  PK: 'CHAT#c1', SK: `MSG#t#0000#${msgId}`, msgId, parentId, role, blocks,
  model: 'm', createdAt: '2025-01-01T00:00:00.000Z', turnIndex: 0, responseId: 'r1',
})

test('returns 404 (no leak) when the share record does not exist', async () => {
  mockDynamo.getShare.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('missing') as any))
  expect(res.statusCode).toBe(404)
  expect(mockDynamo.getChat).not.toHaveBeenCalled()
})

test('returns 404 when the underlying chat no longer exists (deleted chat -> dead link)', async () => {
  mockDynamo.getShare.mockResolvedValue({ shareId: 's1', sub: 'user-1', chatId: 'c1', mode: 'live' })
  mockDynamo.getChat.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('s1') as any))
  expect(res.statusCode).toBe(404)
})

test('live mode renders the chat\'s CURRENT active path as HTML by default', async () => {
  mockDynamo.getShare.mockResolvedValue({
    shareId: 's1', sub: 'user-1', chatId: 'c1', mode: 'live', includeThinking: false, includeTools: false,
  })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', title: 'My Chat', activeLeafId: 'a2' })
  mockDynamo.listMessages.mockResolvedValue([
    row('u1', null, 'user', [{ text: 'hi' }]),
    row('a1', 'u1', 'assistant', [{ text: 'first answer' }]),
    row('u2', 'a1', 'user', [{ text: 'follow-up' }]),
    row('a2', 'u2', 'assistant', [{ text: 'second answer' }]),
  ])

  const res = result(await handler(makeEvent('s1') as any))
  expect(res.statusCode).toBe(200)
  expect((res.headers as Record<string, string>)['Content-Type']).toContain('text/html')
  expect(res.body).toContain('My Chat')
  expect(res.body).toContain('second answer')
})

test('snapshot mode only renders msgIds frozen at creation, ignoring later turns', async () => {
  mockDynamo.getShare.mockResolvedValue({
    shareId: 's1', sub: 'user-1', chatId: 'c1', mode: 'snapshot', includeThinking: false, includeTools: false,
    snapshotMsgIds: ['u1', 'a1'],
  })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', title: 'My Chat', activeLeafId: 'a2' })
  mockDynamo.listMessages.mockResolvedValue([
    row('u1', null, 'user', [{ text: 'hi' }]),
    row('a1', 'u1', 'assistant', [{ text: 'frozen answer' }]),
    row('u2', 'a1', 'user', [{ text: 'added after snapshot' }]),
    row('a2', 'u2', 'assistant', [{ text: 'answer added after snapshot' }]),
  ])

  const res = result(await handler(makeEvent('s1') as any))
  expect(res.body).toContain('frozen answer')
  expect(res.body).not.toContain('added after snapshot')
})

test('snapshot mode drops a msgId that was later deleted from the chat', async () => {
  mockDynamo.getShare.mockResolvedValue({
    shareId: 's1', sub: 'user-1', chatId: 'c1', mode: 'snapshot', includeThinking: false, includeTools: false,
    snapshotMsgIds: ['u1', 'a1'],
  })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', title: 'My Chat' })
  // a1 was deleted since the snapshot was taken -- listMessages no longer returns it
  mockDynamo.listMessages.mockResolvedValue([
    row('u1', null, 'user', [{ text: 'hi' }]),
  ])

  const res = result(await handler(makeEvent('s1') as any))
  expect(res.statusCode).toBe(200)
  expect(res.body).toContain('hi')
})

test('.md path suffix returns Markdown with the shareId stripped of the extension', async () => {
  mockDynamo.getShare.mockResolvedValue({
    shareId: 's1', sub: 'user-1', chatId: 'c1', mode: 'live', includeThinking: false, includeTools: false,
  })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', title: 'My Chat', activeLeafId: 'a1' })
  mockDynamo.listMessages.mockResolvedValue([
    row('u1', null, 'user', [{ text: 'hi' }]),
    row('a1', 'u1', 'assistant', [{ text: 'answer' }]),
  ])

  const res = result(await handler(makeEvent('s1.md') as any))
  expect(mockDynamo.getShare).toHaveBeenCalledWith('s1')
  expect(res.statusCode).toBe(200)
  expect((res.headers as Record<string, string>)['Content-Type']).toContain('text/markdown')
  expect(res.body).toContain('## Assistant')
})

test('?format=md and Accept: text/markdown also select Markdown', async () => {
  mockDynamo.getShare.mockResolvedValue({
    shareId: 's1', sub: 'user-1', chatId: 'c1', mode: 'live', includeThinking: false, includeTools: false,
  })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', title: 'My Chat', activeLeafId: 'a1' })
  mockDynamo.listMessages.mockResolvedValue([row('a1', null, 'assistant', [{ text: 'answer' }])])

  const res1 = result(await handler(makeEvent('s1', { format: 'md' }) as any))
  expect((res1.headers as Record<string, string>)['Content-Type']).toContain('text/markdown')

  const res2 = result(await handler(makeEvent('s1', { accept: 'text/markdown' }) as any))
  expect((res2.headers as Record<string, string>)['Content-Type']).toContain('text/markdown')
})

test('excludes thinking and tool steps when includeThinking/includeTools are false', async () => {
  mockDynamo.getShare.mockResolvedValue({
    shareId: 's1', sub: 'user-1', chatId: 'c1', mode: 'live', includeThinking: false, includeTools: false,
  })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', title: 'My Chat', activeLeafId: 'a1' })
  mockDynamo.listMessages.mockResolvedValue([
    row('a1', null, 'assistant', [
      { reasoningContent: { reasoningText: { text: 'secret reasoning' } } },
      { toolUse: { toolUseId: 't1', name: 'web_search', input: {} } },
      { text: 'visible answer' },
    ]),
  ])

  const res = result(await handler(makeEvent('s1') as any))
  expect(res.body).not.toContain('secret reasoning')
  expect(res.body).not.toContain('web_search')
  expect(res.body).toContain('visible answer')
})

test('includes thinking and tool steps when both flags are true', async () => {
  mockDynamo.getShare.mockResolvedValue({
    shareId: 's1', sub: 'user-1', chatId: 'c1', mode: 'live', includeThinking: true, includeTools: true,
  })
  mockDynamo.getChat.mockResolvedValue({ PK: 'USER#user-1', SK: 'CHAT#c1', title: 'My Chat', activeLeafId: 'a1' })
  mockDynamo.listMessages.mockResolvedValue([
    row('a1', null, 'assistant', [
      { reasoningContent: { reasoningText: { text: 'visible reasoning' } } },
      { toolUse: { toolUseId: 't1', name: 'web_search', input: {} } },
      { text: 'visible answer' },
    ]),
  ])

  const res = result(await handler(makeEvent('s1') as any))
  expect(res.body).toContain('visible reasoning')
  expect(res.body).toContain('web_search')
  expect(res.body).toContain('visible answer')
})
