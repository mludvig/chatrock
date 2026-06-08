import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'

export const handler = async (
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => ({
  statusCode: 200,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify({
    message: 'Chatrock backend is alive',
    region: process.env.AWS_REGION ?? 'unknown',
    env: process.env.APP_ENV ?? 'unknown',
  }),
})
