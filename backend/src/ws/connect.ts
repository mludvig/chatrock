import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { putConnection, buildConnKey } from '../lib/dynamo'

interface WSConnectEvent {
  requestContext: {
    connectionId: string
    authorizer: { sub: string }
  }
}

export const handler = async (
  event: WSConnectEvent,
): Promise<APIGatewayProxyResultV2> => {
  const connId = event.requestContext.connectionId
  const sub    = event.requestContext.authorizer.sub
  const ttl    = Math.floor(Date.now() / 1000) + 3600 // 1-hour TTL

  await putConnection({
    ...buildConnKey(connId),
    userSub: sub,
    connectedAt: new Date().toISOString(),
    ttl,
  })

  return { statusCode: 200, body: 'Connected' }
}
