import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi'
import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { v4 as uuidv4 } from 'uuid'
import type { Message } from '@aws-sdk/client-bedrock-runtime'
import { getConnection, getChat, listMessages, putMessage, updateChatTitle, buildMsgKey } from '../lib/dynamo'
import { converseStream, converseOnce } from '../lib/bedrock'
import { TITLE_MODEL, type ModelSettings } from '../config/models'

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

  const chat = await getChat(sub, chatId)
  if (!chat) {
    await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'error', message: 'Chat not found' }) })
    return { statusCode: 200, body: '' }
  }

  // Persist user message
  const now = new Date().toISOString()
  const userMsgId = uuidv4()
  await putMessage({
    ...buildMsgKey(chatId, now, userMsgId),
    role: 'user',
    content,
    model,
    createdAt: now,
  })

  // Build Bedrock message history (only user/assistant text messages)
  const history = await listMessages(chatId)
  const bedrockMessages: Message[] = history.map(m => ({
    role: m.role as 'user' | 'assistant',
    content: [{ text: m.content as string }],
  }))

  console.log(JSON.stringify({ event: 'stream_start', chatId, model, connId }))
  let fullText = ''

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
          fullText += chunk.text
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

  // Persist assistant message (text only — tool calls are ephemeral)
  if (fullText) {
    const assistantNow = new Date().toISOString()
    const assistantMsgId = uuidv4()
    await putMessage({
      ...buildMsgKey(chatId, assistantNow, assistantMsgId),
      role: 'assistant',
      content: fullText,
      model,
      createdAt: assistantNow,
    })
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
