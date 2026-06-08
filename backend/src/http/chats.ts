import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { v4 as uuidv4 } from 'uuid'
import { listChats, getChat, putChat, deleteChat, updateChatTitle, buildChatKey } from '../lib/dynamo'
import { subFromClaims } from '../lib/auth'

const CORS = { 'Access-Control-Allow-Origin': '*' }

const ok = (body: unknown, status = 200): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(body),
})

const err = (status: number, message: string): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify({ message }),
})

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const sub = subFromClaims(event.requestContext.authorizer.jwt.claims)
  const route = event.routeKey

  if (route === 'GET /api/chats') {
    const items = await listChats(sub)
    const chats = items.map(i => ({
      chatId: (i.SK as string).replace('CHAT#', ''),
      title: i.title,
      model: i.model,
      systemPrompt: i.systemPrompt,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    }))
    return ok({ chats })
  }

  if (route === 'POST /api/chats') {
    const body = JSON.parse(event.body ?? '{}')
    const chatId = uuidv4()
    const now = new Date().toISOString()
    await putChat({
      ...buildChatKey(sub, chatId),
      title: 'New Chat',
      model: body.model ?? process.env.DEFAULT_MODEL,
      systemPrompt: body.systemPrompt ?? '',
      createdAt: now,
      updatedAt: now,
    })
    return ok({ chatId }, 201)
  }

  const chatId = event.pathParameters?.chatId
  if (!chatId) return err(400, 'Missing chatId')

  if (route === 'PATCH /api/chats/{chatId}') {
    const body = JSON.parse(event.body ?? '{}')
    const chat = await getChat(sub, chatId)
    if (!chat) return err(404, 'Not found')
    if (body.title) await updateChatTitle(sub, chatId, body.title)
    return ok({ ok: true })
  }

  if (route === 'DELETE /api/chats/{chatId}') {
    const chat = await getChat(sub, chatId)
    if (!chat) return err(404, 'Not found')
    await deleteChat(sub, chatId)
    return { statusCode: 204, headers: CORS, body: '' }
  }

  return err(404, 'Not found')
}
