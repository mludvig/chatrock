import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { getChat, listMessages } from '../lib/dynamo'
import { subFromClaims } from '../lib/auth'

const CORS = { 'Access-Control-Allow-Origin': '*' }

const ok = (body: unknown): APIGatewayProxyResultV2 => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(body),
})

const err = (status: number, msg: string): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify({ message: msg }),
})

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const sub = subFromClaims(event.requestContext.authorizer.jwt.claims)
  const chatId = event.pathParameters?.chatId
  if (!chatId) return err(400, 'Missing chatId')

  const chat = await getChat(sub, chatId)
  if (!chat) return err(404, 'Not found')

  const items = await listMessages(chatId)
  const messages = items.map(i => ({
    msgId: (i.SK as string).split('#').pop(),
    role: i.role,
    content: i.content,
    model: i.model,
    createdAt: i.createdAt,
    ...(i.thinking   ? { thinking: i.thinking }   : {}),
    ...(i.toolCalls  ? { toolCalls: i.toolCalls }  : {}),
  }))
  return ok({ messages })
}
