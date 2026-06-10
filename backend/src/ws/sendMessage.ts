import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi'
import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { v4 as uuidv4 } from 'uuid'
import type { Message, ContentBlock } from '@aws-sdk/client-bedrock-runtime'
import { getConnection, getChat, listMessages, putMessage, updateChatTitle, updateChatActiveLeaf, buildTurnKey } from '../lib/dynamo'
import { converseStream, converseOnce, type TokenUsage } from '../lib/bedrock'
import { buildActivePath, type TurnRow } from '../lib/tree'
import { TITLE_MODEL, isValidModelId, type ModelSettings } from '../config/models'

interface WSSendEvent {
  requestContext: {
    connectionId: string
    domainName: string
    stage: string
  }
  body?: string
}

type PostFn = (params: { ConnectionId: string; Data: string }) => Promise<void>

export const buildHandler = (postFn: PostFn) => async (
  event: WSSendEvent,
): Promise<APIGatewayProxyResultV2> => {
  const connId = event.requestContext.connectionId
  const body = JSON.parse(event.body ?? '{}') as {
    chatId: string
    content: string
    model: string
    systemPrompt: string
    modelSettings?: ModelSettings
  }
  const { chatId, content, model, systemPrompt, modelSettings = {} } = body

  const conn = await getConnection(connId)
  if (!conn) return { statusCode: 410, body: 'Gone' }
  const sub = conn.userSub as string

  if (!isValidModelId(model)) {
    await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'error', message: 'Invalid model' }) })
    return { statusCode: 200, body: '' }
  }

  const chat = await getChat(sub, chatId)
  if (!chat) {
    await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'error', message: 'Chat not found' }) })
    return { statusCode: 200, body: '' }
  }

  // Capture the response start time once — all turns of this response share it
  // so their SKs (MSG#<ts>#<seq>#<id>) sort together in order.
  const responseStartTs = new Date().toISOString()
  const responseId = uuidv4()
  let seq = 0

  // currentLeafId: the msgId of the chat's current active leaf — becomes the
  // parentId of the first (user) turn in this response.
  const currentLeafId: string | null = (chat.activeLeafId as string | undefined) ?? null

  // Load prior turn history BEFORE persisting the new user turn so we can
  // build the replay path from prior rows + the in-memory user turn (avoids
  // a second DDB round-trip and works correctly when tests mock listMessages).
  const priorRows = await listMessages(chatId)

  // Persist the user prompt as a turn record (format C, tree-aware)
  const userMsgId = uuidv4()
  const userTurnRow: TurnRow = {
    PK: `CHAT#${chatId}`,
    ...buildTurnKey(chatId, responseStartTs, seq, responseId) as { SK: string },
    msgId: userMsgId,
    parentId: currentLeafId,
    role: 'user',
    blocks: [{ text: content }] as ContentBlock[],
    model,
    createdAt: responseStartTs,
    turnIndex: 0,
    responseId,
  }
  await putMessage({ ...userTurnRow, ...buildTurnKey(chatId, responseStartTs, seq++, userMsgId) })

  // Build Bedrock message history via the active-path tree walk.
  // Combine prior rows with the just-created user turn, then walk the active path
  // so only root→activeLeaf blocks are replayed (for a linear chat, all rows in order).
  // Replay blocks verbatim so reasoning signatures + prompt-caching prefix are preserved.
  const allRows: TurnRow[] = [...priorRows as unknown as TurnRow[], userTurnRow]
  const activePath = buildActivePath(allRows, userMsgId)
  const bedrockMessages: Message[] = activePath.map(m => ({
    role: m.role as 'user' | 'assistant',
    content: (m.blocks ?? []) as ContentBlock[],
  }))

  // Track the msgId of the last persisted turn so we can update activeLeafId after streaming
  let lastTurnMsgId: string = userMsgId

  console.log(JSON.stringify({ event: 'stream_start', chatId, model, connId }))

  // Track the latest usage for forwarding
  let lastUsage: TokenUsage | undefined

  try {
    for await (const chunk of converseStream(model, systemPrompt, bedrockMessages, modelSettings)) {
      switch (chunk.type) {
        case 'thinking_delta':
          await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'thinking_delta', text: chunk.text }) })
          break
        case 'thinking_done':
          await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'thinking_done' }) })
          break
        case 'delta':
          await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'delta', text: chunk.text }) })
          break
        case 'tool_call_start':
          await postFn({ ConnectionId: connId, Data: JSON.stringify({
            type: 'tool_call_start',
            toolUseId: chunk.toolUseId,
            name: chunk.name,
          }) })
          break
        case 'tool_call':
          await postFn({ ConnectionId: connId, Data: JSON.stringify({
            type: 'tool_call',
            toolUseId: chunk.toolUseId,
            name: chunk.name,
            input: chunk.input,
          }) })
          break
        case 'tool_result':
          await postFn({ ConnectionId: connId, Data: JSON.stringify({
            type: 'tool_result',
            toolUseId: chunk.toolUseId,
            name: chunk.name,
            isError: chunk.isError,
            content: chunk.content,
          }) })
          break
        case 'turn': {
          // Backend-only: persist one record per Converse turn (format C, tree-aware)
          const turnMsgId = uuidv4()
          const turnTs = new Date().toISOString()
          await putMessage({
            ...buildTurnKey(chatId, responseStartTs, seq++, turnMsgId),
            msgId: turnMsgId,
            parentId: lastTurnMsgId,  // chains: user → asst → tool-result → asst …
            role: chunk.role,
            blocks: chunk.content,
            model,
            createdAt: turnTs,
            turnIndex: chunk.turnIndex,
            responseId,
            ...(chunk.role === 'assistant' && lastUsage ? { usage: lastUsage } : {}),
          })
          lastTurnMsgId = turnMsgId
          break
        }
        case 'usage':
          lastUsage = chunk.usage
          // Forward as a compact WS event for live token stats display
          await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'usage', usage: chunk.usage }) })
          break
        case 'stop':
          await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'done', stopReason: chunk.stopReason }) })
          break
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ event: 'stream_error', chatId, model, error: String(err) }))
    await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'error', message: String(err) }) })
    return { statusCode: 200, body: '' }
  }

  // Update the chat's active leaf to the final persisted turn
  try {
    await updateChatActiveLeaf(sub, chatId, lastTurnMsgId)
  } catch (e) {
    console.error(JSON.stringify({ event: 'active_leaf_update_error', chatId, error: String(e) }))
  }

  // Auto-title on first exchange
  if (chat.title === 'New Chat') {
    const titlePrompt = `Generate a very short chat title (max 6 words) for this conversation. Reply with ONLY the title, no quotes, no punctuation at the end.\n\nUser: ${content}`
    const title = await converseOnce(TITLE_MODEL, '', [
      { role: 'user', content: [{ text: titlePrompt }] },
    ])
    if (title) {
      await updateChatTitle(sub, chatId, title)
      await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'titleUpdated', chatId, title }) })
    }
  }

  return { statusCode: 200, body: '' }
}

export const handler = async (
  event: WSSendEvent,
): Promise<APIGatewayProxyResultV2> => {
  const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`
  const apigwClient = new ApiGatewayManagementApiClient({ endpoint })
  const postFn: PostFn = ({ ConnectionId, Data }) =>
    apigwClient.send(new PostToConnectionCommand({ ConnectionId, Data })).then(() => {})
  return buildHandler(postFn)(event)
}
