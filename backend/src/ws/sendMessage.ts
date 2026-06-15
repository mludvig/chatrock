import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi'
import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { v4 as uuidv4 } from 'uuid'
import type { Message, ContentBlock } from '@aws-sdk/client-bedrock-runtime'
import { getConnection, getChat, listMessages, putMessage, updateChatTitle, updateChatActiveLeaf, buildTurnKey, isStreamCancelled, clearStreamCancel, getUserPrefs, listUserMemories, putUserMemory, buildUserMemKey } from '../lib/dynamo'
import { converseStream, converseOnce, type TokenUsage } from '../lib/bedrock'
import type { ToolContext } from '../lib/tools'
import { buildActivePath, type TurnRow } from '../lib/tree'
import { TITLE_MODEL, MEMORY_EXTRACTION_MODEL, isValidModelId, type ModelSettings } from '../config/models'
import { attachmentBlock, hydrateBlocks, type AttachmentMeta } from '../lib/attachments'
import { resolvePreferences } from '../lib/preferences'
import { assembleSystemPrompt } from '../lib/promptAssembly'
import { extractUserFacts, reconcile, type UserMemory } from '../lib/memory'

function buildUserBlocks(content: string | undefined, attachments: AttachmentMeta[]): ContentBlock[] {
  const attachBlocks: ContentBlock[] = attachments.map(a => attachmentBlock(a))
  if (content) return [{ text: content }, ...attachBlocks]
  // No text — attachment-only send: Bedrock rejects blank/whitespace text blocks
  return attachBlocks
}

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
    content?: string
    model: string
    systemPrompt: string
    modelSettings?: ModelSettings
    parentId?: string | null
    attachments?: AttachmentMeta[]
  }
  const { chatId, content, model, systemPrompt, modelSettings = {}, parentId: rerunParentId, attachments = [] } = body
  // Detect edit/re-run by key presence (not value) so parentId: null (root edit) is handled.
  const hasParentId = 'parentId' in body
  // Re-run: parentId key present and no content = regenerate answer as a sibling
  const isRerun = hasParentId && !content
  // Edit: parentId key present and content present = new user-turn sibling with edited content
  const isEdit = hasParentId && !!content

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

  // Load and resolve user preferences (+ memories only when memoryEnabled)
  const memoryEnabled = modelSettings.memoryEnabled !== false
  const [userPrefs, userMemoriesRaw] = await Promise.all([
    getUserPrefs(sub),
    memoryEnabled ? listUserMemories(sub) : Promise.resolve([]),
  ])
  const effectivePrefs = resolvePreferences({ user: userPrefs })

  // Merge preference inference defaults into modelSettings
  // (client per-send value wins if defined)
  const effectiveModelSettings: ModelSettings = {
    thinkingEffort: effectivePrefs.thinkingEffort,
    webSearch: effectivePrefs.webSearch,
    temperature: effectivePrefs.temperature,
    topP: effectivePrefs.topP,
    topK: effectivePrefs.topK,
    ...modelSettings,  // client values override
  }

  // Assemble the effective system prompt (server-authoritative)
  const now = new Date().toISOString()
  const memoriesForPrompt = memoryEnabled
    ? userMemoriesRaw.map(i => ({ memId: i.memId as string, text: i.text as string, category: i.category as string }))
    : []
  const effectiveSystemPrompt = assembleSystemPrompt({
    basePrompt: systemPrompt,
    prefs: effectivePrefs,
    memories: memoriesForPrompt,
    now,
    memoryToolEnabled: memoryEnabled,
  })

  // Build tool context for manage_memory (sub from authenticated connection, never from client)
  const toolCtx: ToolContext = { sub }

  // Capture the response start time once — all turns of this response share it
  // so their SKs (MSG#<ts>#<seq>#<id>) sort together in order.
  const responseStartTs = new Date().toISOString()
  const responseId = uuidv4()
  let seq = 0

  // Load prior turn history before any writes (avoids a second DDB round-trip
  // and works correctly when tests mock listMessages).
  const priorRows = await listMessages(chatId)

  let lastTurnMsgId: string
  let bedrockMessages: Message[]

  if (isRerun) {
    // ── Re-run path: generate a sibling answer for the given parentId ──────────
    // Validate: parentId must resolve to a known row
    const priorById = new Map((priorRows as unknown as TurnRow[]).map(r => [r.msgId, r]))
    if (!priorById.has(rerunParentId!)) {
      await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'error', message: 'Re-run parentId not found' }) })
      return { statusCode: 200, body: '' }
    }
    // Replay history: root→parentId (user turn that prompted the original answer).
    // The original answer is NOT included — the new answer is a fresh sibling.
    const replayPath = buildActivePath(priorRows as unknown as TurnRow[], rerunParentId!)
    bedrockMessages = await Promise.all(
      replayPath.map(async m => ({
        role: m.role as 'user' | 'assistant',
        content: await hydrateBlocks((m.blocks ?? []) as ContentBlock[]),
      }))
    )
    // New assistant turns chain from the re-run parent
    lastTurnMsgId = rerunParentId!
  } else if (isEdit) {
    // ── Edit path: new user-turn sibling under the given parentId ─────────────
    // body.parentId is the tree-parent of the message being edited (may be null
    // for a root-level edit). Validate non-null parentIds exist in priorRows.
    const editParentId: string | null = rerunParentId ?? null
    if (editParentId !== null) {
      const priorById = new Map((priorRows as unknown as TurnRow[]).map(r => [r.msgId, r]))
      if (!priorById.has(editParentId)) {
        await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'error', message: 'Edit parentId not found' }) })
        return { statusCode: 200, body: '' }
      }
    }
    const userMsgId = uuidv4()
    const userTurnRow: TurnRow = {
      PK: `CHAT#${chatId}`,
      ...buildTurnKey(chatId, responseStartTs, seq, responseId) as { SK: string },
      msgId: userMsgId,
      parentId: editParentId,
      role: 'user',
      blocks: buildUserBlocks(content, attachments),
      model,
      createdAt: responseStartTs,
      turnIndex: 0,
      responseId,
    }
    await putMessage({ ...userTurnRow, ...buildTurnKey(chatId, responseStartTs, seq++, userMsgId) })
    const allRows: TurnRow[] = [...priorRows as unknown as TurnRow[], userTurnRow]
    bedrockMessages = await Promise.all(
      buildActivePath(allRows, userMsgId).map(async m => ({
        role: m.role as 'user' | 'assistant',
        content: await hydrateBlocks((m.blocks ?? []) as ContentBlock[]),
      }))
    )
    lastTurnMsgId = userMsgId
  } else {
    // ── Normal send path ──────────────────────────────────────────────────────
    // currentLeafId: msgId of the chat's current active leaf; becomes the
    // parentId of the new user turn.
    const currentLeafId: string | null = (chat.activeLeafId as string | undefined) ?? null

    // Persist the user prompt as a turn record (format C, tree-aware)
    const userMsgId = uuidv4()
    const userTurnRow: TurnRow = {
      PK: `CHAT#${chatId}`,
      ...buildTurnKey(chatId, responseStartTs, seq, responseId) as { SK: string },
      msgId: userMsgId,
      parentId: currentLeafId,
      role: 'user',
      blocks: buildUserBlocks(content, attachments),
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
    bedrockMessages = await Promise.all(
      activePath.map(async m => ({
        role: m.role as 'user' | 'assistant',
        content: await hydrateBlocks((m.blocks ?? []) as ContentBlock[]),
      }))
    )
    lastTurnMsgId = userMsgId
  }

  console.log(JSON.stringify({ event: 'stream_start', chatId, model, connId }))

  // Clear any stale cancel flag from a previous stream on this connection
  await clearStreamCancel(connId)

  const abortController = new AbortController()
  let cancelled = false

  // Mid-turn cancel poller: checks the cancel flag every 750ms and aborts the
  // Bedrock stream if set. Runs in parallel with the stream loop.
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  const startPollTimer = () => {
    pollTimer = setTimeout(async () => {
      if (abortController.signal.aborted) return
      if (await isStreamCancelled(connId)) {
        abortController.abort()
      } else {
        startPollTimer()
      }
    }, 750)
  }
  startPollTimer()

  // Track the latest usage for forwarding
  let lastUsage: TokenUsage | undefined

  // Partial-turn accumulator for mid-turn abort flush
  let partialText = ''
  let partialTurnIndex = 0

  // Accumulates assistant text across all turns for post-stream memory extraction
  let assistantTextForMemory = ''

  try {
    for await (const chunk of converseStream(model, effectiveSystemPrompt, bedrockMessages, effectiveModelSettings, toolCtx, abortController.signal)) {
      switch (chunk.type) {
        case 'thinking_delta':
          await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'thinking_delta', text: chunk.text }) })
          break
        case 'thinking_done':
          await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'thinking_done' }) })
          break
        case 'delta':
          partialText += chunk.text
          assistantTextForMemory += chunk.text
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
            ...(chunk.role === 'assistant' && effectiveModelSettings.thinkingEffort !== undefined
              ? { thinkingEffort: effectiveModelSettings.thinkingEffort } : {}),
            ...(chunk.role === 'assistant' && effectiveModelSettings.webSearch !== undefined
              ? { webSearch: effectiveModelSettings.webSearch } : {}),
          })
          lastTurnMsgId = turnMsgId
          // Reset partial accumulator — this turn is fully persisted
          partialText = ''
          partialTurnIndex = chunk.turnIndex + 1
          break
        }
        case 'usage':
          lastUsage = chunk.usage
          // Forward as a compact WS event for live token stats display
          await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'usage', usage: chunk.usage }) })
          break
        case 'memoryChanged':
          // Tool loop signalled that manage_memory succeeded — notify the client
          await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'memoryUpdated', count: 1 }) })
          break
        case 'stop':
          // Update activeLeafId before sending 'done' so the client's
          // reloadMessages() refetch sees the new active path immediately.
          try {
            await updateChatActiveLeaf(sub, chatId, lastTurnMsgId)
          } catch (e) {
            console.error(JSON.stringify({ event: 'active_leaf_update_error', chatId, error: String(e) }))
          }
          await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'done', stopReason: chunk.stopReason }) })
          console.log(JSON.stringify({
            event: 'llm_call',
            purpose: 'chat',
            model,
            chatId,
            stopReason: chunk.stopReason,
            ...(lastUsage ? {
              inputTokens: lastUsage.inputTokens,
              outputTokens: lastUsage.outputTokens,
              ...(lastUsage.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: lastUsage.cacheReadInputTokens } : {}),
              ...(lastUsage.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: lastUsage.cacheWriteInputTokens } : {}),
            } : {}),
          }))
          break
      }
    }
  } catch (err) {
    // Check if abort was requested (either via signal or cancel flag)
    const wasAborted = abortController.signal.aborted || await isStreamCancelled(connId)
    if (wasAborted) {
      cancelled = true
      // Flush any partial text accumulated before the abort
      if (partialText) {
        const turnMsgId = uuidv4()
        const turnTs = new Date().toISOString()
        await putMessage({
          ...buildTurnKey(chatId, responseStartTs, seq, turnMsgId),
          msgId: turnMsgId,
          parentId: lastTurnMsgId,
          role: 'assistant',
          blocks: [{ text: partialText }],
          model,
          createdAt: turnTs,
          turnIndex: partialTurnIndex,
          responseId,
        })
        lastTurnMsgId = turnMsgId
      }
    } else {
      clearTimeout(pollTimer)
      console.error(JSON.stringify({ event: 'stream_error', chatId, model, error: String(err) }))
      await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'error', message: String(err) }) })
      return { statusCode: 200, body: '' }
    }
  }

  clearTimeout(pollTimer)

  if (cancelled) {
    try {
      await updateChatActiveLeaf(sub, chatId, lastTurnMsgId)
    } catch (e) {
      console.error(JSON.stringify({ event: 'active_leaf_update_error', chatId, error: String(e) }))
    }
    await clearStreamCancel(connId)
    console.log(JSON.stringify({ event: 'stream_cancelled', chatId, connId }))
    await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'cancelled' }) })
    return { statusCode: 200, body: '' }
  }

  // Auto-title on first normal send only (not re-run, not edit)
  if (!isRerun && !isEdit && chat.title === 'New Chat') {
    try {
      const titlePrompt = `Generate a very short chat title (max 6 words) for this conversation. Reply with ONLY the title, no quotes, no punctuation at the end.\n\nUser: ${content!}`
      const title = await converseOnce(TITLE_MODEL, '', [
        { role: 'user', content: [{ text: titlePrompt }] },
      ])
      if (title) {
        await updateChatTitle(sub, chatId, title)
        await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'titleUpdated', chatId, title }) })
        console.log(JSON.stringify({ event: 'llm_call', purpose: 'title', model: TITLE_MODEL, chatId, title }))
      }
    } catch (err) {
      console.error(JSON.stringify({ event: 'llm_call_error', purpose: 'title', chatId, error: String(err) }))
    }
  }

  // ── Post-turn memory extraction (non-blocking) ────────────────────────────
  // Runs after the turn is fully persisted and the client has its response.
  // Errors are swallowed — memory failure must never break the chat turn.
  // Skipped entirely when memoryEnabled is false.
  if (memoryEnabled) {
    try {
      const transcript = [
        `User: ${content ?? ''}`,
        `Assistant: ${assistantTextForMemory}`,
      ].join('\n')
      const existing = await listUserMemories(sub)
      const existingMemories: UserMemory[] = existing.map(i => ({
        memId: i.memId as string,
        text: i.text as string,
        category: i.category as UserMemory['category'],
        createdAt: i.createdAt as string,
        updatedAt: i.updatedAt as string,
      }))
      const candidates = await extractUserFacts(transcript)
      const ops = reconcile(candidates, existingMemories)
      const memNow = new Date().toISOString()
      for (const op of ops) {
        if (op.op === 'ADD') {
          const memId = uuidv4()
          await putUserMemory({
            ...buildUserMemKey(sub, memId),
            memId,
            text: op.text,
            category: op.category,
            createdAt: memNow,
            updatedAt: memNow,
          })
        }
        // UPDATE and DELETE not implemented in Phase 1
      }
      const newCount = ops.filter(o => o.op === 'ADD').length
      console.log(JSON.stringify({
        event: 'llm_call',
        purpose: 'memory_extract',
        model: MEMORY_EXTRACTION_MODEL,
        chatId,
        candidateCount: candidates.length,
        addedCount: newCount,
      }))
      if (newCount > 0) {
        await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'memoryUpdated', count: newCount }) })
      }
    } catch (err) {
      console.error(JSON.stringify({ event: 'memory_extraction_error', chatId, error: String(err) }))
      // Swallow: memory extraction failure must never break a chat turn
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
