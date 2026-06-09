import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { v4 as uuidv4 } from 'uuid'
import { listChats, getChat, putChat, deleteChat, updateChatTitle, updateChatSystemPrompt, updateChatModel, buildChatKey, listMessages } from '../lib/dynamo'
import { converseOnce } from '../lib/bedrock'
import { TITLE_MODEL } from '../config/models'
import { subFromClaims } from '../lib/auth'

const corsHeader = () => ({ 'Access-Control-Allow-Origin': `https://${process.env.DOMAIN_NAME}` })

const ok = (body: unknown, status = 200): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', ...corsHeader() },
  body: JSON.stringify(body),
})

const err = (status: number, message: string): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', ...corsHeader() },
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
    if (body.title !== undefined) await updateChatTitle(sub, chatId, body.title)
    if (body.systemPrompt !== undefined) await updateChatSystemPrompt(sub, chatId, body.systemPrompt)
    if (body.model !== undefined) await updateChatModel(sub, chatId, body.model)
    return ok({ ok: true })
  }

  if (route === 'DELETE /api/chats/{chatId}') {
    const chat = await getChat(sub, chatId)
    if (!chat) return err(404, 'Not found')
    await deleteChat(sub, chatId)
    return { statusCode: 204, headers: corsHeader(), body: '' }
  }

  if (route === 'POST /api/chats/{chatId}/retitle') {
    const chat = await getChat(sub, chatId)
    if (!chat) return err(404, 'Not found')
    const messages = await listMessages(chatId)
    if (messages.length === 0) return err(400, 'No messages to generate title from')
    const transcript = messages
      .slice(-10)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${(m.content as string).slice(0, 300)}`)
      .join('\n')
    const titlePrompt = `Generate a very short chat title (max 6 words) that captures the main topic of this conversation. Reply with ONLY the title, no quotes, no punctuation at the end.\n\n${transcript}`
    const title = await converseOnce(TITLE_MODEL, '', [
      { role: 'user', content: [{ text: titlePrompt }] },
    ])
    if (!title) return err(500, 'Title generation failed')
    await updateChatTitle(sub, chatId, title)
    return ok({ title })
  }

  return err(404, 'Not found')
}
