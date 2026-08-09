import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { listUserMemories, deleteUserMemory, updateUserMemory } from '../lib/dynamo'
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

  if (route === 'PATCH /api/memory/{memId}') {
    const memId = event.pathParameters?.memId
    if (!memId) return err(400, 'Missing memId')

    let body: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(event.body ?? '{}')
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch { return err(400, 'Invalid JSON body') }

    if (body.text !== undefined && (typeof body.text !== 'string' || body.text.trim() === '')) {
      return err(400, 'text cannot be empty')
    }
    const validCategories = ['identity', 'preference', 'style', 'other']
    if (body.category !== undefined && !validCategories.includes(body.category as string)) {
      return err(400, `category must be one of: ${validCategories.join(', ')}`)
    }

    const fields: Partial<{ text: string; category: string }> = {}
    if (body.text !== undefined) fields.text = (body.text as string).trim()
    if (body.category !== undefined) fields.category = body.category as string
    await updateUserMemory(sub, memId, fields)
    return ok({ ok: true })
  }

  return err(404, 'Not found')
}
