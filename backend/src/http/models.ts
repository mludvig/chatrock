import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { MODELS } from '../config/models'

export const handler = async (
  _event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => ({
  statusCode: 200,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': `https://${process.env.DOMAIN_NAME}`,
  },
  body: JSON.stringify({ models: MODELS }),
})
