import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { listUserMemories, deleteUserMemory } from '../lib/dynamo'
import { subFromClaims } from '../lib/auth'
import type { UserMemory } from '../lib/memory'

const ok = (body: unknown, status = 200): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const err = (status: number, message: string): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message }),
})

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const sub = subFromClaims(event.requestContext.authorizer.jwt.claims)
  const route = event.routeKey

  if (route === 'GET /api/memory') {
    const items = await listUserMemories(sub)
    const memories: UserMemory[] = items.map(i => ({
      memId: i.memId as string,
      text: i.text as string,
      category: i.category as UserMemory['category'],
      createdAt: i.createdAt as string,
      updatedAt: i.updatedAt as string,
    }))
    return ok({ memories })
  }

  if (route === 'DELETE /api/memory/{memId}') {
    const memId = event.pathParameters?.memId
    if (!memId) return err(400, 'Missing memId')
    await deleteUserMemory(sub, memId)
    return { statusCode: 204, body: '' }
  }

  return err(404, 'Not found')
}
