import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn'
import { getConnection, putRun, buildRunKey } from '../lib/dynamo'
import { newId } from '../lib/ids'

const sfn = new SFNClient({})
const STATE_MACHINE_ARN = process.env.RESEARCH_STATE_MACHINE_ARN ?? ''

interface WSEvent {
  requestContext: { connectionId: string }
  body?: string
}

interface StartResearchBody {
  chatId: string
  question: string
}

// WS action "startResearch" — mints a runId, writes the initial RUN# row, and starts the
// Step Functions execution (terraform/research.tf) at Recon. connId is threaded into the
// execution input so every state can push a best-effort progress frame back to this
// connection (lib/wsNotify.ts) — see research/CLAUDE.md's "Progress frames and reconnect".
export const handler = async (event: WSEvent): Promise<APIGatewayProxyResultV2> => {
  const connId = event.requestContext.connectionId
  const conn = await getConnection(connId)
  if (!conn) return { statusCode: 410, body: 'Gone' }

  const body = JSON.parse(event.body ?? '{}') as StartResearchBody
  const { chatId, question } = body
  if (!chatId || !question?.trim()) return { statusCode: 400, body: 'chatId and question are required' }

  const runId = newId()
  const now = new Date().toISOString()
  await putRun({
    ...buildRunKey(chatId, runId),
    runId,
    chatId,
    sub: conn.userSub,
    status: 'recon',
    question,
    connId,
    findings: [],
    gapsNotPursued: [],
    steeringNotes: [],
    roundsSpent: 0,
    createdAt: now,
    updatedAt: now,
  })

  await sfn.send(new StartExecutionCommand({
    stateMachineArn: STATE_MACHINE_ARN,
    name: runId,
    input: JSON.stringify({ chatId, runId, sub: conn.userSub, question, connId }),
  }))

  console.log(JSON.stringify({ event: 'research_start', runId, chatId }))
  return { statusCode: 200, body: JSON.stringify({ runId }) }
}
