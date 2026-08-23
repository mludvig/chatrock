import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { getConnection, getRun } from '../lib/dynamo'
import { resolvePlanApproval } from '../lib/researchApproval'

interface WSEvent {
  requestContext: { connectionId: string }
  body?: string
}

interface ApproveBody {
  chatId: string
  runId: string
  // Named "decision", not "action" — the WS envelope's own `action: 'researchApprove'`
  // is what API Gateway's route_selection_expression ($request.body.action) matches on
  // (terraform/apigw_ws.tf); reusing that key here would collide with routing.
  decision: 'approve' | 'revise'
  // Freetext feedback. Required for "revise" (drives a Replan). Optional for "approve" —
  // if present it's folded in as steering for the first wave instead of triggering a
  // replan, per the plan's "approve, or revise, or go from there" design.
  feedback?: string
}

// WS action "researchApprove" — the panel's Approve button. Feedback typed into the main
// composer takes the other route into the same resolver, through ws/sendMessage.ts; the
// mechanics of releasing the task token live in lib/researchApproval.ts. There is no
// "reject": a user who doesn't like the plan just abandons the chat, and AwaitApproval's
// 24h TimeoutSeconds fails the run cleanly on its own — cleanup doesn't need a button.
export const handler = async (event: WSEvent): Promise<APIGatewayProxyResultV2> => {
  const connId = event.requestContext.connectionId
  const conn = await getConnection(connId)
  if (!conn) return { statusCode: 410, body: 'Gone' }

  const body = JSON.parse(event.body ?? '{}') as ApproveBody
  const { chatId, runId, decision, feedback } = body

  if (decision === 'revise' && !feedback?.trim()) {
    return { statusCode: 400, body: 'feedback is required to revise' }
  }

  const run = await getRun(chatId, runId)
  if (!run || run.sub !== conn.userSub) return { statusCode: 404, body: 'Not found' }

  const outcome = await resolvePlanApproval({ chatId, runId, connId, run, decision, feedback })
  if (outcome === 'not_found') return { statusCode: 404, body: 'Not found' }
  if (outcome === 'not_awaiting') return { statusCode: 409, body: 'Not awaiting approval' }
  return { statusCode: 200, body: '' }
}
