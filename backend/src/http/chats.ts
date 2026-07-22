import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { v4 as uuidv4 } from 'uuid'
import { newId } from '../lib/ids'
import { listChats, getChat, putChat, deleteChatItem, updateChatTitle, updateChatSystemPrompt, updateChatModel, updateChatActiveLeaf, updateChatModelSettings, updateChatSensitive, updateChatEphemeral, buildChatKey, buildTurnKey, listMessages, batchPutMessages, batchDeleteMessages, getProject, updateChatProject, updateChatSummary, putSharePair, listChatShares, deleteSharePair, buildShareLookupKey, buildShareIndexKey } from '../lib/dynamo'
import { converseOnce } from '../lib/bedrock'
import { TITLE_MODEL, DEFAULT_CHAT_MODEL, isValidModelId } from '../config/models'
import { subFromClaims } from '../lib/auth'
import { resolveLeaf, resolveResponseLeaf, resolveSafeLeaf, buildActivePath, subtreeMsgIds, type TurnRow } from '../lib/tree'
import { validateAttachment, presignPut, copyChatObjects, rewriteBlockUri, s3KeyPrefix } from '../lib/attachments'
import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime'
import { summarizeChatById } from '../lib/enrichment'
import { groupTurnsToBubbles, filterSteps, renderMarkdown } from '../lib/transcript'

const ok = (body: unknown, status = 200): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const EPHEMERAL_CHAT_TTL_SECONDS = Number(process.env.EPHEMERAL_CHAT_TTL_SECONDS ?? 604800)

const err = (status: number, message: string): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message }),
})

// A chat's stored `model` can go stale when that model id is later retired from
// config/models.ts (e.g. a renamed inference profile with no back-compat alias). Rather than a
// bulk migration, this self-heals lazily the next time the chat is read: swap in
// DEFAULT_CHAT_MODEL and report what changed so the client can show a one-time notice. Only
// affects the NEXT message — Message rows keep their own historical `model` field untouched, so
// past turns still show what actually generated them.
async function resolveChatModel(sub: string, chatId: string, chat: Record<string, unknown>): Promise<{ model: string; modelMigratedFrom?: string }> {
  const model = chat.model as string
  if (isValidModelId(model)) return { model }
  await updateChatModel(sub, chatId, DEFAULT_CHAT_MODEL)
  console.log(JSON.stringify({ event: 'chat_model_migrated', sub, chatId, from: model, to: DEFAULT_CHAT_MODEL }))
  return { model: DEFAULT_CHAT_MODEL, modelMigratedFrom: model }
}

// Chat item -> client DTO. Shared by the list and single-chat GET routes so both expose the
// same shape — sensitive chats ARE included (the sidebar eye/mask handles visibility, not the
// API), only their content (memory/summary/search) is excluded elsewhere.
async function chatDto(sub: string, i: Record<string, unknown>) {
  const chatId = (i.SK as string).replace('CHAT#', '')
  const { model, modelMigratedFrom } = await resolveChatModel(sub, chatId, i)
  return {
    chatId,
    title: i.title,
    model,
    systemPrompt: i.systemPrompt,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    ...(i.activeLeafId !== undefined ? { activeLeafId: i.activeLeafId } : {}),
    ...(i.modelSettings !== undefined ? { modelSettings: i.modelSettings } : {}),
    ...(i.projectId !== undefined ? { projectId: i.projectId } : {}),
    ...(i.summary !== undefined ? { summary: i.summary } : {}),
    ...(i.topics !== undefined ? { topics: i.topics } : {}),
    ...(i.sensitive === true ? { sensitive: true } : {}),
    ...(i.ephemeral === true ? { ephemeral: true, expiresAt: new Date((i.ttl as number) * 1000).toISOString() } : {}),
    ...(modelMigratedFrom ? { modelMigratedFrom } : {}),
  }
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const sub = subFromClaims(event.requestContext.authorizer.jwt.claims)
  const route = event.routeKey

  if (route === 'GET /api/chats') {
    const items = await listChats(sub)
    // Sensitive chats ARE returned — the frontend's sidebar eye toggle hides/masks them by
    // default, but the API doesn't filter them out (see "Sensitive & ephemeral chats" in
    // backend/CLAUDE.md).
    const chats = await Promise.all(items.map(i => chatDto(sub, i)))
    return ok({ chats })
  }

  if (route === 'POST /api/chats') {
    let body: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(event.body ?? '{}')
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      return err(400, 'Invalid JSON body')
    }
    const model = (body.model as string | undefined) ?? process.env.DEFAULT_MODEL ?? ''
    if (body.model !== undefined && !isValidModelId(model)) return err(400, 'Invalid model')
    const clientId = body.chatId as string | undefined
    // Lowercase-only: chatId becomes the CHAT# sort key, so a client-supplied
    // id must match newId()'s shape exactly or it breaks ULID sort ordering
    // for that one record (see lib/ids.ts).
    const ULID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/
    if (clientId !== undefined && !ULID_RE.test(clientId)) return err(400, 'Invalid chatId')
    if (clientId) {
      const existing = await getChat(sub, clientId)
      if (existing) return err(409, 'Chat already exists')
    }
    const chatId = clientId ?? newId()
    const now = new Date().toISOString()
    if (body.projectId !== undefined && body.projectId !== null && typeof body.projectId !== 'string') {
      return err(400, 'projectId must be a string')
    }
    if (body.sensitive !== undefined && typeof body.sensitive !== 'boolean') {
      return err(400, 'sensitive must be a boolean')
    }
    if (body.ephemeral !== undefined && typeof body.ephemeral !== 'boolean') {
      return err(400, 'ephemeral must be a boolean')
    }
    const sensitive = body.sensitive === true
    const ephemeral = body.ephemeral === true
    // sensitive/ephemeral are independent flags — both are allowed on project chats. A
    // sensitive chat still reads project context in (instructions/files/memory) but never
    // writes back to it; see "Sensitive & ephemeral chats" in backend/CLAUDE.md.
    await putChat({
      ...buildChatKey(sub, chatId),
      title: 'New Chat',
      model,
      systemPrompt: (body.systemPrompt as string | undefined) ?? '',
      ...(body.modelSettings !== undefined && typeof body.modelSettings === 'object' && body.modelSettings !== null && !Array.isArray(body.modelSettings)
        ? { modelSettings: body.modelSettings }
        : {}),
      ...(body.projectId !== undefined && body.projectId !== null ? { projectId: body.projectId as string } : {}),
      ...(sensitive ? { sensitive: true } : {}),
      // TTL is fixed at creation time, not sliding — see "Sensitive & ephemeral chats" in
      // backend/CLAUDE.md. Cascade cleanup (messages + S3) runs off the Chat item's own
      // DynamoDB Stream REMOVE event (terraform/stream_chat_cleanup.tf), not this ttl field
      // directly, so there's nothing else to wire up here.
      ...(ephemeral ? { ephemeral: true, ttl: Math.floor(Date.now() / 1000) + EPHEMERAL_CHAT_TTL_SECONDS } : {}),
      createdAt: now,
      updatedAt: now,
    })
    console.log(JSON.stringify({ event: 'chat_created', sub, chatId, model, sensitive, ephemeral }))
    return ok({ chatId }, 201)
  }

  if (route === 'POST /api/attachments') {
    let body: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(event.body ?? '{}')
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      return err(400, 'Invalid JSON body')
    }
    const { chatId: uploadChatId, filename, contentType, sizeBytes } = body as {
      chatId?: string; filename?: string; contentType?: string; sizeBytes?: number
    }
    if (!uploadChatId || !filename || !contentType || typeof sizeBytes !== 'number') {
      return err(400, 'Missing required fields: chatId, filename, contentType, sizeBytes')
    }
    try {
      validateAttachment(contentType as string, sizeBytes, filename as string)
    } catch (e) {
      return err(400, (e as Error).message)
    }
    const fileId = uuidv4()
    const safeName = (filename as string).replace(/[/\\]/g, '-').replace(/\0/g, '').replace(/^\.+/, '_')
    const s3Key = `${s3KeyPrefix(sub, uploadChatId as string)}${fileId}/${safeName}`
    const uploadUrl = await presignPut(s3Key, contentType as string)
    console.log(JSON.stringify({ event: 'attachment_upload_requested', sub, chatId: uploadChatId, s3Key }))
    return ok({ s3Key, uploadUrl })
  }

  const chatId = event.pathParameters?.chatId
  if (!chatId) return err(400, 'Missing chatId')

  if (route === 'GET /api/chats/{chatId}') {
    const chat = await getChat(sub, chatId)
    if (!chat) return err(404, 'Not found')
    return ok(await chatDto(sub, chat))
  }

  if (route === 'PATCH /api/chats/{chatId}') {
    let body: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(event.body ?? '{}')
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      return err(400, 'Invalid JSON body')
    }
    const chat = await getChat(sub, chatId)
    if (!chat) return err(404, 'Not found')
    const updatedFields: string[] = []
    if (body.title !== undefined) {
      if (typeof body.title !== 'string') return err(400, 'title must be a string')
      await updateChatTitle(sub, chatId, body.title)
      updatedFields.push('title')
    }
    if (body.systemPrompt !== undefined) {
      await updateChatSystemPrompt(sub, chatId, body.systemPrompt as string)
      updatedFields.push('systemPrompt')
    }
    if (body.model !== undefined) {
      if (typeof body.model !== 'string' || !isValidModelId(body.model)) return err(400, 'Invalid model')
      await updateChatModel(sub, chatId, body.model)
      updatedFields.push('model')
    }
    if (body.activeLeafId !== undefined) {
      if (typeof body.activeLeafId !== 'string') return err(400, 'activeLeafId must be a string')
      const rows = await listMessages(chatId)
      const rowSet = rows as unknown as TurnRow[]
      if (!rowSet.some(r => r.msgId === body.activeLeafId as string)) return err(400, 'Unknown activeLeafId')
      const leaf = resolveLeaf(rowSet, body.activeLeafId as string)
      await updateChatActiveLeaf(sub, chatId, leaf)
      updatedFields.push('activeLeafId')
    }
    if (body.modelSettings !== undefined) {
      if (typeof body.modelSettings !== 'object' || body.modelSettings === null || Array.isArray(body.modelSettings)) {
        return err(400, 'modelSettings must be a plain object')
      }
      await updateChatModelSettings(sub, chatId, body.modelSettings as Record<string, unknown>)
      updatedFields.push('modelSettings')
    }
    if (body.sensitive !== undefined) {
      if (typeof body.sensitive !== 'boolean') return err(400, 'sensitive must be a boolean')
      await updateChatSensitive(sub, chatId, body.sensitive)
      updatedFields.push('sensitive')
    }
    if (body.ephemeral !== undefined) {
      if (typeof body.ephemeral !== 'boolean') return err(400, 'ephemeral must be a boolean')
      await updateChatEphemeral(sub, chatId, body.ephemeral, EPHEMERAL_CHAT_TTL_SECONDS)
      updatedFields.push('ephemeral')
    }
    if (body.projectId !== undefined) {
      // sensitive/ephemeral no longer block project membership — a sensitive chat reads
      // project context in but never writes back to it (see backend/CLAUDE.md).
      const prevProjectId = chat.projectId as string | undefined
      if (body.projectId === null) {
        await updateChatProject(sub, chatId, null)
      } else if (typeof body.projectId === 'string') {
        const proj = await getProject(sub, body.projectId)
        if (!proj) return err(400, 'Invalid projectId')
        await updateChatProject(sub, chatId, body.projectId)
        if (!prevProjectId) await summarizeChatById(sub, chatId)
      } else {
        return err(400, 'projectId must be a string or null')
      }
      updatedFields.push('projectId')
    }
    if (body.summary !== undefined || body.topics !== undefined) {
      if (body.summary !== undefined && typeof body.summary !== 'string') {
        return err(400, 'summary must be a string')
      }
      if (body.topics !== undefined && (
        !Array.isArray(body.topics) || !body.topics.every(t => typeof t === 'string')
      )) {
        return err(400, 'topics must be an array of strings')
      }
      await updateChatSummary(sub, chatId, {
        ...(body.summary !== undefined ? { summary: body.summary as string } : {}),
        ...(body.topics !== undefined ? { topics: body.topics as string[] } : {}),
      })
      updatedFields.push(...(body.summary !== undefined ? ['summary'] : []), ...(body.topics !== undefined ? ['topics'] : []))
    }
    console.log(JSON.stringify({ event: 'chat_updated', sub, chatId, fields: updatedFields }))
    return ok({ ok: true })
  }

  if (route === 'DELETE /api/chats/{chatId}') {
    const chat = await getChat(sub, chatId)
    if (!chat) return err(404, 'Not found')
    // Only the Chat item is deleted here — the DynamoDB Stream REMOVE event it produces
    // triggers stream_chat_cleanup (streams/chatTtlCleanup.ts), which cascades the delete
    // to this chat's messages + S3 attachments. Same cascade path TTL expiry uses, so there's
    // one cleanup implementation instead of two. See backend/CLAUDE.md for the full rationale.
    await deleteChatItem(sub, chatId)
    console.log(JSON.stringify({ event: 'chat_deleted', sub, chatId }))
    return { statusCode: 204, body: '' }
  }

  if (route === 'POST /api/chats/{chatId}/retitle') {
    const chat = await getChat(sub, chatId)
    if (!chat) return err(404, 'Not found')
    // Title generation is allowed for sensitive chats — the title is stored on the chat
    // itself and masked by the sidebar eye, unlike memory/summary which resurface elsewhere.
    const messages = await listMessages(chatId)
    if (messages.length === 0) return err(400, 'No messages to generate title from')
    const transcript = messages
      .slice(-10)
      .map(m => {
        const blocks = (m.blocks as Array<{ text?: string }> | undefined) ?? []
        const text = blocks.map(b => b.text ?? '').join(' ').slice(0, 300)
        return `${m.role === 'user' ? 'User' : 'Assistant'}: ${text}`
      })
      .join('\n')
    const titlePrompt = `Generate a very short chat title (max 6 words) that captures the main topic of this conversation. Reply with ONLY the title, no quotes, no punctuation at the end.\n\n${transcript}`
    const title = await converseOnce(TITLE_MODEL, '', [
      { role: 'user', content: [{ text: titlePrompt }] },
    ])
    if (!title) return err(500, 'Title generation failed')
    await updateChatTitle(sub, chatId, title)
    return ok({ title })
  }

  if (route === 'POST /api/chats/{chatId}/resummarize') {
    const chat = await getChat(sub, chatId)
    if (!chat) return err(404, 'Not found')
    // Summary is what search_history indexes, so a sensitive chat's content must never flow
    // through this even on manual trigger.
    if (chat.sensitive === true) return err(400, 'Cannot generate a summary for a sensitive chat')
    const result = await summarizeChatById(sub, chatId)
    if (!result) return err(500, 'Summary generation failed')
    return ok({ summary: result.summary, topics: result.topics })
  }

  if (route === 'POST /api/chats/{chatId}/fork') {
    let body: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(event.body ?? '{}')
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      return err(400, 'Invalid JSON body')
    }
    if (typeof body.fromMsgId !== 'string') return err(400, 'fromMsgId must be a string')
    const fromMsgId = body.fromMsgId as string

    const chat = await getChat(sub, chatId)
    if (!chat) return err(404, 'Not found')
    // A fork must never propagate a stale model id forward — resolve (and self-heal the
    // source chat too, as a side effect) before copying it onto the new chat below.
    const { model: sourceModel } = await resolveChatModel(sub, chatId, chat)

    const rows = (await listMessages(chatId)) as unknown as TurnRow[]
    const fromRow = rows.find(r => r.msgId === fromMsgId)
    if (!fromRow) return err(400, 'Unknown fromMsgId')

    // Resolve the leaf to clone up to (always ends on a complete response group):
    //   assistant bubble → leaf of its response group (handles multi-turn tool-use)
    //   user bubble      → its parent (leaf of the previous group); null → empty clone
    const cloneLeaf = fromRow.role === 'assistant'
      ? resolveResponseLeaf(rows, fromMsgId)
      : fromRow.parentId
    const path = cloneLeaf ? buildActivePath(rows, cloneLeaf) : []

    // Remap rows into the new chat partition with fresh msgIds and responseIds
    const newChatId = newId()
    const now = new Date().toISOString()
    const idMap = new Map<string, string>()     // old msgId → new msgId
    const respMap = new Map<string, string>()   // old responseId → new responseId
    let seq = 0
    const cloned = path.map(r => {
      const newMsgId = uuidv4()
      idMap.set(r.msgId, newMsgId)
      if (!respMap.has(r.responseId)) respMap.set(r.responseId, uuidv4())
      return {
        ...buildTurnKey(newChatId, r.createdAt, seq++, newMsgId),
        msgId: newMsgId,
        // root→leaf order ensures every parent is already in idMap when its child is processed
        parentId: r.parentId ? (idMap.get(r.parentId) ?? null) : null,
        role: r.role,
        blocks: r.blocks,   // verbatim — preserves reasoning signatures + prompt-cache prefix
        model: r.model,
        createdAt: r.createdAt,
        turnIndex: r.turnIndex,
        responseId: respMap.get(r.responseId)!,
        ...(r.usage ? { usage: r.usage } : {}),
      }
    })

    await putChat({
      ...buildChatKey(sub, newChatId),
      title: `${chat.title} (fork)`,
      model: sourceModel,
      systemPrompt: (chat.systemPrompt as string | undefined) ?? '',
      ...(chat.modelSettings !== undefined ? { modelSettings: chat.modelSettings } : {}),
      ...(chat.projectId !== undefined ? { projectId: chat.projectId } : {}),
      // A fork inherits both flags from its source. ephemeral gets a FRESH ttl (fork is
      // itself a creation event) rather than the source's remaining ttl.
      ...(chat.sensitive === true ? { sensitive: true } : {}),
      ...(chat.ephemeral === true ? { ephemeral: true, ttl: Math.floor(Date.now() / 1000) + EPHEMERAL_CHAT_TTL_SECONDS } : {}),
      createdAt: now,
      updatedAt: now,
      ...(cloned.length ? { activeLeafId: cloned[cloned.length - 1].msgId } : {}),
    })
    if (cloned.length) await batchPutMessages(cloned)

    const keyMap = await copyChatObjects(sub, chatId, newChatId)
    if (keyMap.size > 0) {
      const rewritten = cloned.map(r => ({
        ...r,
        blocks: (r.blocks as ContentBlock[]).map(b => rewriteBlockUri(b, keyMap)),
      }))
      await batchPutMessages(rewritten)
    }

    console.log(JSON.stringify({ event: 'chat_forked', sub, chatId, newChatId, fromMsgId, clonedCount: cloned.length }))
    return ok({ chatId: newChatId }, 201)
  }

  if (route === 'DELETE /api/chats/{chatId}/messages/{msgId}') {
    const msgId = event.pathParameters?.msgId
    if (!msgId) return err(400, 'Missing msgId')

    const chat = await getChat(sub, chatId)
    if (!chat) return err(404, 'Not found')

    const rows = (await listMessages(chatId)) as unknown as TurnRow[]
    const targetRow = rows.find(r => r.msgId === msgId)
    if (!targetRow) return err(404, 'Message not found')

    // Refuse to delete a root only when it's the sole root (no parent to reset activeLeafId
    // to). A root with a sibling root — e.g. an accidental edit that forked at the top level —
    // is safe to delete: resolveSafeLeaf below falls back to the surviving root's leaf.
    if (targetRow.parentId === null && !rows.some(r => r.parentId === null && r.msgId !== msgId)) {
      return err(400, 'Cannot delete the only root message')
    }

    const toDelete = subtreeMsgIds(rows, msgId)
    const toDeleteSet = new Set(toDelete)

    // Build PK+SK pairs for batch delete by looking up full keys in rows
    const keys = rows
      .filter(r => toDeleteSet.has(r.msgId))
      .map(r => ({ PK: r.PK, SK: r.SK }))

    await batchDeleteMessages(keys)

    // Reset activeLeafId if the active leaf is inside the deleted subtree.
    // Resolve to the leaf of the surviving branch under the same parent, so the active
    // path stays on a complete assistant response. Uses resolveSafeLeaf (not bare
    // resolveLeaf) because targetRow.parentId can itself be absent from remainingRows —
    // e.g. it was never durably persisted due to an earlier, unrelated failure. A bare
    // resolveLeaf would silently return that phantom id unchanged; resolveSafeLeaf falls
    // back to the most-recently-created surviving leaf instead.
    const activeLeafId = chat.activeLeafId as string | undefined
    if (activeLeafId && toDeleteSet.has(activeLeafId)) {
      const remainingRows = rows.filter(r => !toDeleteSet.has(r.msgId))
      const newLeaf = resolveSafeLeaf(remainingRows, targetRow.parentId)
      // remainingRows always has at least one surviving root (deleting the sole root is
      // refused above), so newLeaf should never be null here — but guard rather than write
      // a bad value.
      if (newLeaf) await updateChatActiveLeaf(sub, chatId, newLeaf)
    }

    console.log(JSON.stringify({ event: 'branch_deleted', sub, chatId, msgId, deletedCount: toDelete.length }))
    return { statusCode: 204, body: '' }
  }

  // ── Chat sharing (read-only public links) ──────────────────────────────────
  // See "Chat sharing" in backend/CLAUDE.md. Public rendering itself lives in http/share.ts
  // (unauthenticated /s/{shareId}) — everything here is authenticated create/list/revoke, gated
  // by the same getChat(sub, chatId) ownership check every other chat route uses.

  if (route === 'POST /api/chats/{chatId}/shares') {
    const chat = await getChat(sub, chatId)
    if (!chat) return err(404, 'Not found')

    let body: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(event.body ?? '{}')
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      return err(400, 'Invalid JSON body')
    }
    const mode = body.mode as string | undefined
    if (mode !== 'live' && mode !== 'snapshot') return err(400, "mode must be 'live' or 'snapshot'")
    if (body.includeThinking !== undefined && typeof body.includeThinking !== 'boolean') {
      return err(400, 'includeThinking must be a boolean')
    }
    if (body.includeTools !== undefined && typeof body.includeTools !== 'boolean') {
      return err(400, 'includeTools must be a boolean')
    }
    const includeThinking = body.includeThinking === true
    const includeTools = body.includeTools === true

    // Snapshot freezes the CURRENT active path's msgIds at creation time. Rendering later
    // filters listMessages(chatId) down to this set — deletions drop out naturally, additions
    // never appear, and it's robust even if the original leaf itself later gets deleted.
    let snapshotMsgIds: string[] | undefined
    if (mode === 'snapshot') {
      const rows = (await listMessages(chatId)) as unknown as TurnRow[]
      const activeLeafId = (chat.activeLeafId as string | undefined) ?? null
      snapshotMsgIds = buildActivePath(rows, activeLeafId).map(r => r.msgId)
    }

    const shareId = newId()
    const now = new Date().toISOString()
    const lookupItem = {
      ...buildShareLookupKey(shareId),
      shareId, sub, chatId, mode, includeThinking, includeTools,
      ...(snapshotMsgIds ? { snapshotMsgIds } : {}),
      createdAt: now,
    }
    const indexItem = {
      ...buildShareIndexKey(chatId, shareId),
      shareId, mode, includeThinking, includeTools, createdAt: now,
    }
    await putSharePair(lookupItem, indexItem)
    console.log(JSON.stringify({ event: 'share_created', sub, chatId, shareId, mode }))
    return ok({ shareId, mode, includeThinking, includeTools, createdAt: now }, 201)
  }

  if (route === 'GET /api/chats/{chatId}/shares') {
    const chat = await getChat(sub, chatId)
    if (!chat) return err(404, 'Not found')
    const items = await listChatShares(chatId)
    const shares = items.map(i => ({
      shareId: i.shareId as string,
      mode: i.mode as 'live' | 'snapshot',
      includeThinking: i.includeThinking === true,
      includeTools: i.includeTools === true,
      createdAt: i.createdAt as string,
    }))
    return ok({ shares })
  }

  if (route === 'DELETE /api/chats/{chatId}/shares/{shareId}') {
    const shareId = event.pathParameters?.shareId
    if (!shareId) return err(400, 'Missing shareId')
    const chat = await getChat(sub, chatId)
    if (!chat) return err(404, 'Not found')
    await deleteSharePair(chatId, shareId)
    console.log(JSON.stringify({ event: 'share_revoked', sub, chatId, shareId }))
    return { statusCode: 204, body: '' }
  }

  if (route === 'GET /api/chats/{chatId}/export') {
    const chat = await getChat(sub, chatId)
    if (!chat) return err(404, 'Not found')

    const includeThinking = event.queryStringParameters?.includeThinking === 'true'
    const includeTools = event.queryStringParameters?.includeTools === 'true'

    const rows = (await listMessages(chatId)) as unknown as TurnRow[]
    const activeLeafId = (chat.activeLeafId as string | undefined) ?? null
    const activePath = buildActivePath(rows, activeLeafId)
    const { bubbles } = await groupTurnsToBubbles(activePath)
    const filtered = filterSteps(bubbles, { includeThinking, includeTools })
    const markdown = renderMarkdown(filtered, { title: (chat.title as string | undefined) ?? 'Chat' })

    console.log(JSON.stringify({ event: 'chat_exported', sub, chatId, includeThinking, includeTools }))
    const safeTitle = ((chat.title as string | undefined) ?? 'chat').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'chat'
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeTitle}.md"`,
      },
      body: markdown,
    }
  }

  return err(404, 'Not found')
}
