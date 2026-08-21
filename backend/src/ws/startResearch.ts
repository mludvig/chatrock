import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn'
import { getConnection, getChat, putRun, buildRunKey, buildTurnKey, putMessage, updateChatActiveLeaf } from '../lib/dynamo'
import { newId } from '../lib/ids'
import { v4 as uuidv4 } from 'uuid'

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

// WS action "startResearch" — persists the question as a user turn, mints a runId, writes
// the initial RUN# row, and starts the Step Functions execution (terraform/research.tf) at
// Recon. connId is threaded into the
// execution input so every state can push a best-effort progress frame back to this
// connection (lib/wsNotify.ts) — see research/CLAUDE.md's "Progress frames and reconnect".
export const handler = async (event: WSEvent): Promise<APIGatewayProxyResultV2> => {
  const connId = event.requestContext.connectionId
  const conn = await getConnection(connId)
  if (!conn) return { statusCode: 410, body: 'Gone' }

  const body = JSON.parse(event.body ?? '{}') as StartResearchBody
  const { chatId, question } = body
  if (!chatId || !question?.trim()) return { statusCode: 400, body: 'chatId and question are required' }

  const chat = await getChat(conn.userSub, chatId)
  if (!chat) return { statusCode: 404, body: 'Not found' }

  // The question is a normal user turn, written before the run starts: it is the parent
  // the final report chains under (report.ts reads activeLeafId), and persisting it here
  // rather than leaving it to the client's optimistic bubble is what makes it survive a
  // reload, a reconnect, or the run outliving the tab that started it.
  const now = new Date().toISOString()
  const userMsgId = uuidv4()
  await putMessage({
    ...buildTurnKey(chatId, now, 0, userMsgId),
    msgId: userMsgId,
    parentId: (chat.activeLeafId as string | undefined) ?? null,
    role: 'user',
    blocks: [{ kind: 'text', text: question }],
    model: chat.model,
    createdAt: now,
    turnIndex: 0,
    responseId: uuidv4(),
  })
  await updateChatActiveLeaf(conn.userSub, chatId, userMsgId)

  const runId = newId()
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

  console.log(JSON.stringify({ event: 'research_start', runId, chatId, userMsgId }))
  return { statusCode: 200, body: JSON.stringify({ runId }) }
}
