import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { deleteConnection } from '../lib/dynamo'

interface WSDisconnectEvent {
  requestContext: { connectionId: string }
}

export const handler = async (
  event: WSDisconnectEvent,
): Promise<APIGatewayProxyResultV2> => {
  await deleteConnection(event.requestContext.connectionId)
  return { statusCode: 200, body: 'Disconnected' }
}
