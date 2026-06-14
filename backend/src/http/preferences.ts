import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { getUserPrefs, putUserPrefs } from '../lib/dynamo'
import { subFromClaims } from '../lib/auth'
import type { UserPreferences } from '../lib/preferences'

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

  if (route === 'GET /api/preferences') {
    const preferences = await getUserPrefs(sub)
    return ok({ preferences })
  }

  if (route === 'PUT /api/preferences') {
    let body: UserPreferences = {}
    try {
      const parsed = JSON.parse(event.body ?? '{}')
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as UserPreferences
      }
    } catch {
      return err(400, 'Invalid JSON body')
    }
    await putUserPrefs(sub, body as Record<string, unknown>)
    return ok({ ok: true })
  }

  return err(404, 'Not found')
}
