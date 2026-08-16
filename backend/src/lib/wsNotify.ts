import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi'

const client = new ApiGatewayManagementApiClient({ endpoint: process.env.WS_MANAGEMENT_ENDPOINT })

// Best-effort WS push for the Deep Research state-machine handlers (backend/src/research/*.ts),
// which run as plain Step Functions Task invocations with no API Gateway event of their own to
// derive a management-API endpoint from — WS_MANAGEMENT_ENDPOINT (lambda_env_base) fills that
// gap. A dead/expired connection (410 Gone) or any other failure is swallowed: these are
// progress frames only, the RUN# row stays the source of truth, and a lost frame is recovered
// via GET /api/chats/{chatId}/research on reconnect (research/CLAUDE.md's "Progress frames and
// reconnect").
export async function notifyConnection(connId: string | undefined, data: Record<string, unknown>): Promise<void> {
  if (!connId) return
  try {
    await client.send(new PostToConnectionCommand({ ConnectionId: connId, Data: JSON.stringify(data) }))
  } catch (err) {
    console.log(JSON.stringify({ event: 'research_notify_failed', connId, error: (err as Error).message }))
  }
}
