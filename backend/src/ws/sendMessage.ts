import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi'
import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { v4 as uuidv4 } from 'uuid'
import type { Message, ContentBlock } from '@aws-sdk/client-bedrock-runtime'
import { getConnection, getChat, listMessages, putMessage, putMessagePair, updateChatTitle, updateChatActiveLeaf, buildTurnKey, isStreamCancelled, clearStreamCancel, getUserPrefs, listUserMemories, putUserMemory, deleteUserMemory, buildUserMemKey, getProject, listProjectMemories, putProjectMemory, deleteProjectMemory, buildProjectMemKey, updateChatSummary, listProjectFiles, listChats } from '../lib/dynamo'
import { converseStream, type TokenUsage } from '../lib/bedrock'
import type { ToolContext } from '../lib/tools'
import { buildActivePath, resolveResponseLeaf, type TurnRow } from '../lib/tree'
import { MEMORY_EXTRACTION_MODEL, isValidModelId, type ModelSettings } from '../config/models'
import { attachmentBlock, hydrateBlocks, type AttachmentMeta } from '../lib/attachments'
import { resolvePreferences, type UserPreferences } from '../lib/preferences'
import { assembleSystemPrompt, type AssembleInput } from '../lib/promptAssembly'
import { reconcileMemoryList } from '../lib/memory'
import { enrichUserFacts, enrichProjectFacts } from '../lib/enrichment'
import { fetchS3Text } from '../lib/projectFiles'

function buildUserBlocks(content: string | undefined, attachments: AttachmentMeta[], tsBlock?: ContentBlock): ContentBlock[] {
  const attachBlocks: ContentBlock[] = attachments.map(a => attachmentBlock(a))
  const prefix: ContentBlock[] = tsBlock ? [tsBlock] : []
  if (content) return [...prefix, { text: content }, ...attachBlocks]
  // No text — attachment-only send: Bedrock rejects blank/whitespace text blocks
  return [...prefix, ...attachBlocks]
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
    continue?: boolean
  }
  const { chatId, content, model, systemPrompt, modelSettings = {}, parentId: rerunParentId, attachments = [] } = body
  // Detect edit/re-run/continue by key presence (not value) so parentId: null (root edit) is handled.
  const hasParentId = 'parentId' in body
  // Continue: parentId key present, no content, and continue:true flag — resume from leaf
  const isContinue = hasParentId && !content && body.continue === true
  // Re-run: parentId key present and no content (and not continue) = regenerate as a sibling
  const isRerun = hasParentId && !content && !isContinue
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

  // Immediate ack: positive confirmation that the send reached the backend.
  // The client arms a short watchdog after sending; receiving any frame (this
  // ack first) proves the WebSocket is live. No ack ⇒ the frame was dropped by
  // a stale connection, and the client recovers instead of hanging on "Processing…".
  await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'ack' }) })

  // Advance the chat's activeLeafId to a just-persisted turn. Called after EVERY
  // turn write (user prompt + each assistant/tool turn + partial flush) so that a
  // non-graceful termination (e.g. Lambda timeout mid-stream) can never orphan
  // committed turns: activeLeafId always points at the latest durable turn, so a
  // page reload or a follow-up send chains from the right place with full context.
  const advanceLeaf = async (msgId: string) => {
    try {
      await updateChatActiveLeaf(sub, chatId, msgId)
    } catch (e) {
      console.error(JSON.stringify({ event: 'active_leaf_update_error', chatId, error: String(e) }))
    }
  }

  // Load and resolve preferences across all three layers: user → project → chat
  // Use client memoryEnabled as a preliminary filter for the DDB memory loads (optimisation).
  const clientMemoryEnabled = modelSettings.memoryEnabled !== false
  const projectId = chat.projectId as string | undefined
  const [userPrefs, userMemoriesRaw, projectItem, projectMemoriesRaw, projectFilesRaw, allChatsRaw] = await Promise.all([
    getUserPrefs(sub),
    clientMemoryEnabled ? listUserMemories(sub) : Promise.resolve([]),
    projectId ? getProject(sub, projectId) : Promise.resolve(undefined),
    (projectId && clientMemoryEnabled) ? listProjectMemories(projectId) : Promise.resolve([]),
    projectId ? listProjectFiles(projectId) : Promise.resolve([]),
    projectId ? listChats(sub) : Promise.resolve([]),
  ])

  const projectPrefs: UserPreferences = projectItem ? {
    defaultModel: projectItem.defaultModel as string | undefined,
    ...(projectItem.modelSettings as Partial<UserPreferences> || {}),
  } : {}

  const chatPrefs: UserPreferences = {
    thinkingEffort:     modelSettings.thinkingEffort,
    webSearchEnabled:   modelSettings.webSearchEnabled,
    webSearchProvider:  modelSettings.webSearchProvider,
    memoryEnabled:      modelSettings.memoryEnabled,
    answerLength:       modelSettings.answerLength as UserPreferences['answerLength'],
    injectCurrentDate:  modelSettings.injectCurrentDate,
  }

  const effectivePrefs = resolvePreferences({ user: userPrefs, project: projectPrefs, chat: chatPrefs })
  const memoryEnabled = effectivePrefs.memoryEnabled !== false

  const effectiveModelSettings: ModelSettings = {
    thinkingEffort:    effectivePrefs.thinkingEffort,
    webSearchEnabled:  effectivePrefs.webSearchEnabled,
    webSearchProvider: effectivePrefs.webSearchProvider,
    memoryEnabled:     effectivePrefs.memoryEnabled,
  }

  // Build project manifest and forced files (project chats only)
  let projectManifest: AssembleInput['projectManifest'] | undefined
  let forcedFiles: Array<{ name: string; content: string }> | undefined

  if (projectId) {
    const typedFiles = projectFilesRaw as Record<string, unknown>[]
    const FILE_MANIFEST_CAP = 50
    const CHAT_MANIFEST_CAP = 30

    const allManifestFiles = typedFiles
      .filter(f => f.status === 'ready' && f.inclusion !== 'never')
      .map(f => ({
        fileId: f.fileId as string,
        name: f.filename as string,
        microLabel: f.microLabel as string | undefined,
        inclusion: f.inclusion as string,
      }))
    const manifestFiles = allManifestFiles.length > FILE_MANIFEST_CAP
      ? (console.log(JSON.stringify({ event: 'manifest_truncated', kind: 'files', total: allManifestFiles.length, kept: FILE_MANIFEST_CAP, projectId, chatId })), allManifestFiles.slice(0, FILE_MANIFEST_CAP))
      : allManifestFiles

    const allSiblingChats = (allChatsRaw as Record<string, unknown>[])
      .filter(c => {
        const cId = (c.SK as string).replace('CHAT#', '')
        return c.projectId === projectId && cId !== chatId
      })
      .map(c => ({
        chatId: (c.SK as string).replace('CHAT#', ''),
        title: c.title as string,
        summary: c.summary as string | undefined,
      }))
    const siblingChats = allSiblingChats.length > CHAT_MANIFEST_CAP
      ? (console.log(JSON.stringify({ event: 'manifest_truncated', kind: 'chats', total: allSiblingChats.length, kept: CHAT_MANIFEST_CAP, projectId, chatId })), allSiblingChats.slice(0, CHAT_MANIFEST_CAP))
      : allSiblingChats

    projectManifest = { files: manifestFiles, chats: siblingChats }

    // Fetch content of always-inclusion text files for forced injection
    const FORCED_FILES_TOTAL_CAP = 80000
    const alwaysFiles = typedFiles.filter(f => f.status === 'ready' && f.inclusion === 'always')
    if (alwaysFiles.length > 0) {
      forcedFiles = []
      let totalForcedChars = 0
      for (let i = 0; i < alwaysFiles.length; i++) {
        const f = alwaysFiles[i]
        const contentType = f.contentType as string
        const isTextLike = contentType.startsWith('text/') || contentType === 'application/octet-stream'
        const keyToRead = (f.extractedTextKey ?? f.s3Key) as string
        if (isTextLike || (contentType === 'application/pdf' && f.extractedTextKey)) {
          try {
            const raw = await fetchS3Text(keyToRead)
            if (totalForcedChars + raw.length > FORCED_FILES_TOTAL_CAP) {
              const remaining = alwaysFiles.length - i
              console.log(JSON.stringify({ event: 'forced_files_truncated', skipped: remaining, totalKept: totalForcedChars, projectId, chatId }))
              break
            }
            const capped = raw.length > 20000 ? raw.slice(0, 20000) + '\n\n[... truncated ...]' : raw
            forcedFiles.push({ name: f.filename as string, content: capped })
            totalForcedChars += raw.length
          } catch { /* skip unreadable file */ }
        }
        // Images and other binary types are excluded from forced injection
      }
    }
  }

  // Assemble the effective system prompt (server-authoritative)
  const now = chat.createdAt as string | undefined
  const memoriesForPrompt = memoryEnabled
    ? userMemoriesRaw.map(i => ({ memId: i.memId as string, text: i.text as string, category: i.category as string }))
    : []
  const projectMemoriesForPrompt = memoryEnabled && projectId
    ? (projectMemoriesRaw as Record<string, unknown>[]).map(i => ({
        memId: i.memId as string,
        text: i.text as string,
        category: i.category as string,
      }))
    : []
  const effectiveSystemPrompt = assembleSystemPrompt({
    basePrompt: systemPrompt,
    prefs: effectivePrefs,
    memories: memoriesForPrompt,
    now,
    memoryToolEnabled: memoryEnabled,
    projectInstructions: projectItem ? (projectItem.instructions as string | undefined) : undefined,
    projectMemories: projectId ? projectMemoriesForPrompt : undefined,
    projectMemoryToolEnabled: !!(projectId && memoryEnabled),
    projectManifest,
    forcedFiles: forcedFiles ?? undefined,
    projectReadToolsEnabled: !!projectId,
  })

  // Build tool context for manage_memory / manage_project_memory / read_project_* (from auth, never client)
  const toolCtx: ToolContext = {
    sub,
    ...(projectId ? { projectId, chatId } : {}),
    ...(effectiveModelSettings.webSearchProvider ? { webSearchProvider: effectiveModelSettings.webSearchProvider } : {}),
  }

  // Timestamp block: prepended to new user turns when injectCurrentDate is enabled.
  // Stored permanently in DDB; the model reads the actual send time for each turn.
  const makeTsBlock = (): ContentBlock | undefined =>
    effectivePrefs.injectCurrentDate ? { text: `Current timestamp: ${new Date().toISOString()}` } : undefined

  // Capture the response start time once — all turns of this response share it
  // so their SKs (MSG#<ts>#<seq>#<id>) sort together in order.
  const responseStartTs = new Date().toISOString()
  const responseId = uuidv4()
  let seq = 0
  // For Continue: reuse the failed response's responseId so groupTurnsToBubbles fuses
  // the partial + continuation into one seamless bubble.
  let continueResponseId: string | undefined

  // Load prior turn history before any writes (avoids a second DDB round-trip
  // and works correctly when tests mock listMessages).
  const priorRows = await listMessages(chatId)

  let lastTurnMsgId: string
  let bedrockMessages: Message[]

  if (isContinue) {
    // ── Continue path: resume generation from an errored/incomplete leaf ────────
    // The client passes the bubble's msgId (first turn of the response).
    // We resolve to the deepest turn within that response group (resolveResponseLeaf)
    // so the replay is always inclusive of the true leaf.
    const priorById = new Map((priorRows as unknown as TurnRow[]).map(r => [r.msgId, r]))
    if (!priorById.has(rerunParentId!)) {
      await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'error', message: 'Continue parentId not found' }) })
      return { statusCode: 200, body: '' }
    }
    // Resolve bubble msgId → deepest turn within its responseId group
    const leafId = resolveResponseLeaf(priorRows as unknown as TurnRow[], rerunParentId!)
    const leafRow = priorById.get(leafId)!
    continueResponseId = leafRow.responseId as string

    // Replay root→leaf INCLUSIVE (continuation extends from the leaf)
    const replayPath = buildActivePath(priorRows as unknown as TurnRow[], leafId)
    bedrockMessages = await Promise.all(
      replayPath.map(async m => ({
        role: m.role as 'user' | 'assistant',
        content: await hydrateBlocks((m.blocks ?? []) as ContentBlock[]),
      }))
    )
    // New turns chain as CHILD of the leaf
    lastTurnMsgId = leafId
  } else if (isRerun) {
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
      blocks: buildUserBlocks(content, attachments, makeTsBlock()),
      model,
      createdAt: responseStartTs,
      turnIndex: 0,
      responseId,
    }
    await putMessage({ ...userTurnRow, ...buildTurnKey(chatId, responseStartTs, seq++, userMsgId) })
    await advanceLeaf(userMsgId)
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
      blocks: buildUserBlocks(content, attachments, makeTsBlock()),
      model,
      createdAt: responseStartTs,
      turnIndex: 0,
      responseId,
    }
    await putMessage({ ...userTurnRow, ...buildTurnKey(chatId, responseStartTs, seq++, userMsgId) })
    await advanceLeaf(userMsgId)

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

  // An assistant turn containing toolUse blocks is held here, NOT yet written, until its
  // paired tool-result turn is also ready — then both are written atomically via
  // putMessagePair. This guarantees the durable tree never ends on a dangling tool_use: a
  // kill/error in this window leaves lastTurnMsgId at the prior (fully complete) turn
  // instead of advancing past a half-written round.
  let pendingAssistantTurn: { item: Record<string, unknown>; msgId: string } | null = null

  // Accumulates assistant text across all turns for post-stream memory extraction
  let assistantTextForMemory = ''
  // Set to true if manage_memory tool was called during the stream.
  // Prevents a second memoryUpdated toast from the passive extractor on the same turn.
  let memoryChangedDuringStream = false

  // Helper: flush any partial text accumulated mid-turn as an incomplete assistant turn.
  // Called from both the cancel path and the error path so partial work is never discarded.
  const flushPartial = async () => {
    if (!partialText) return
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
      responseId: continueResponseId ?? responseId,
      incomplete: true,
    })
    lastTurnMsgId = turnMsgId
    await advanceLeaf(turnMsgId)
  }

  let errored = false
  let errorMessage = ''

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
          // Chain from the pending (not-yet-durable) assistant turn if one is awaiting its
          // pair, otherwise from the last durable turn: user → asst → tool-result → asst …
          const parentId: string = pendingAssistantTurn?.msgId ?? lastTurnMsgId
          const item: Record<string, unknown> = {
            ...buildTurnKey(chatId, responseStartTs, seq++, turnMsgId),
            msgId: turnMsgId,
            parentId,
            role: chunk.role,
            blocks: chunk.content,
            model,
            createdAt: turnTs,
            turnIndex: chunk.turnIndex,
            // Continue reuses the failed response's responseId so bubbles fuse
            responseId: continueResponseId ?? responseId,
            ...(chunk.role === 'assistant' && lastUsage ? { usage: lastUsage } : {}),
            ...(chunk.role === 'assistant' && effectiveModelSettings.thinkingEffort !== undefined
              ? { thinkingEffort: effectiveModelSettings.thinkingEffort } : {}),
            ...(chunk.role === 'assistant' && effectiveModelSettings.webSearchEnabled !== undefined
              ? { webSearchEnabled: effectiveModelSettings.webSearchEnabled } : {}),
          }

          const hasToolUse = chunk.role === 'assistant' && chunk.content.some(b => 'toolUse' in b)

          if (hasToolUse) {
            // Hold this turn until its tool-result turn arrives — do NOT advance
            // lastTurnMsgId or the durable leaf yet; this round isn't durable until paired.
            pendingAssistantTurn = { item, msgId: turnMsgId }
            break
          }

          if (pendingAssistantTurn) {
            // This is the tool-result turn completing the pending round — write both
            // atomically so the tree can never end on a dangling tool_use.
            await putMessagePair(pendingAssistantTurn.item, item)
            pendingAssistantTurn = null
          } else {
            await putMessage(item)
          }
          lastTurnMsgId = turnMsgId
          // Advance the durable leaf as each (now-complete) round commits, so a mid-stream
          // kill (e.g. Lambda timeout) never orphans this turn from the active path.
          await advanceLeaf(turnMsgId)
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
          memoryChangedDuringStream = true
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
      await flushPartial()
    } else {
      errored = true
      errorMessage = String(err)
      console.error(JSON.stringify({ event: 'stream_error', chatId, model, error: errorMessage }))
      await flushPartial()
    }
  }

  clearTimeout(pollTimer)

  if (errored) {
    // Advance activeLeafId to the last persisted turn (partial or prior round) so
    // the active path is correct for a Continue operation or page reload.
    try {
      await updateChatActiveLeaf(sub, chatId, lastTurnMsgId)
    } catch (e) {
      console.error(JSON.stringify({ event: 'active_leaf_update_error', chatId, error: String(e) }))
    }
    await postFn({ ConnectionId: connId, Data: JSON.stringify({
      type: 'error',
      message: errorMessage,
      responseId,
      leafId: lastTurnMsgId,
    }) })
    return { statusCode: 200, body: '' }
  }

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

  // ── Post-turn enrichment (two Haiku calls: user facts + project facts/summary) ──
  // Skipped when memoryEnabled is false.
  if (memoryEnabled) {
    try {
      const needTitle = !isRerun && !isEdit && !isContinue && chat.title === 'New Chat'
      const isProject = !!projectId

      const transcript = [
        `User: ${content ?? ''}`,
        `Assistant: ${assistantTextForMemory}`,
      ].join('\n')

      const memNow = new Date().toISOString()
      let totalChanged = 0

      // ── User facts (reuse userMemoriesRaw already loaded for the system prompt) ──
      const existingUserMems = userMemoriesRaw.map(i => ({
        memId: i.memId as string,
        text: i.text as string,
        category: i.category as string,
        createdAt: i.createdAt as string,
      }))
      const userResult = await enrichUserFacts(transcript, existingUserMems, needTitle)
      const userOps = reconcileMemoryList(userResult.memories, existingUserMems)
      for (const op of userOps) {
        if (op.op === 'ADD') {
          const memId = uuidv4()
          await putUserMemory({ ...buildUserMemKey(sub, memId), memId, text: op.text, category: op.category, createdAt: memNow, updatedAt: memNow })
          totalChanged++
        } else if (op.op === 'UPDATE') {
          await putUserMemory({ ...buildUserMemKey(sub, op.memId), memId: op.memId, text: op.text, category: op.category, createdAt: op.createdAt, updatedAt: memNow })
          totalChanged++
        } else if (op.op === 'DELETE') {
          await deleteUserMemory(sub, op.memId)
          totalChanged++
        }
      }

      // Title
      if (userResult.title) {
        await updateChatTitle(sub, chatId, userResult.title)
        await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'titleUpdated', chatId, title: userResult.title }) })
      }

      // ── Project facts + summary (reuse projectMemoriesRaw already loaded) ──
      if (isProject && projectId) {
        const existingProjectMems = (projectMemoriesRaw as Record<string, unknown>[]).map(i => ({
          memId: i.memId as string,
          text: i.text as string,
          category: i.category as string,
          createdAt: i.createdAt as string,
        }))
        const projectResult = await enrichProjectFacts(transcript, existingProjectMems)
        const projectOps = reconcileMemoryList(projectResult.memories, existingProjectMems)
        for (const op of projectOps) {
          if (op.op === 'ADD') {
            const memId = uuidv4()
            await putProjectMemory({ ...buildProjectMemKey(projectId, memId), memId, text: op.text, category: op.category, createdAt: memNow, updatedAt: memNow })
            totalChanged++
          } else if (op.op === 'UPDATE') {
            await putProjectMemory({ ...buildProjectMemKey(projectId, op.memId), memId: op.memId, text: op.text, category: op.category, createdAt: op.createdAt, updatedAt: memNow })
            totalChanged++
          } else if (op.op === 'DELETE') {
            await deleteProjectMemory(projectId, op.memId)
            totalChanged++
          }
        }
        if (projectResult.summary) {
          await updateChatSummary(sub, chatId, projectResult.summary)
        }
      }

      if (totalChanged > 0 && !memoryChangedDuringStream) {
        await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'memoryUpdated', count: totalChanged }) })
      }

      console.log(JSON.stringify({ event: 'llm_call', purpose: 'enrich_turn', model: MEMORY_EXTRACTION_MODEL, chatId }))
    } catch (err) {
      console.error(JSON.stringify({ event: 'enrich_turn_error', chatId, error: String(err) }))
      await postFn({ ConnectionId: connId, Data: JSON.stringify({ type: 'warning', message: 'Post-turn enrichment failed (memory/summary not updated)' }) })
      // Never re-throw — enrichment failure must not break the chat turn
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
