import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { getConnection, setStreamCancel } from '../lib/dynamo'

interface WSEvent {
  requestContext: { connectionId: string }
  body?: string
}

export const handler = async (event: WSEvent): Promise<APIGatewayProxyResultV2> => {
  const connId = event.requestContext.connectionId
  const conn = await getConnection(connId)
  if (!conn) return { statusCode: 410, body: 'Gone' }
  await setStreamCancel(connId)
  console.log(JSON.stringify({ event: 'cancel_requested', connId, userSub: conn.userSub }))
  return { statusCode: 200, body: '' }
}
