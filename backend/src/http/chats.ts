import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { v4 as uuidv4 } from 'uuid'
import { listChats, getChat, putChat, deleteChat, updateChatTitle, updateChatSystemPrompt, updateChatModel, updateChatActiveLeaf, buildChatKey, buildTurnKey, listMessages, batchPutMessages, batchDeleteMessages } from '../lib/dynamo'
import { converseOnce } from '../lib/bedrock'
import { TITLE_MODEL, isValidModelId } from '../config/models'
import { subFromClaims } from '../lib/auth'
import { resolveLeaf, resolveResponseLeaf, buildActivePath, subtreeMsgIds, type TurnRow } from '../lib/tree'
import { validateAttachment, presignPut, deleteChatObjects, copyChatObjects, rewriteBlockUri, s3KeyPrefix } from '../lib/attachments'
import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime'

const ok = (body: unknown, status = 200): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const err = (status: number, message: string): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message }),
})

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const sub = subFromClaims(event.requestContext.authorizer.jwt.claims)
  const route = event.routeKey

  if (route === 'GET /api/chats') {
    const items = await listChats(sub)
    const chats = items.map(i => ({
      chatId: (i.SK as string).replace('CHAT#', ''),
      title: i.title,
      model: i.model,
      systemPrompt: i.systemPrompt,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      ...(i.activeLeafId !== undefined ? { activeLeafId: i.activeLeafId } : {}),
    }))
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
    const chatId = uuidv4()
    const now = new Date().toISOString()
    await putChat({
      ...buildChatKey(sub, chatId),
      title: 'New Chat',
      model,
      systemPrompt: (body.systemPrompt as string | undefined) ?? '',
      createdAt: now,
      updatedAt: now,
    })
    console.log(JSON.stringify({ event: 'chat_created', sub, chatId, model }))
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
      validateAttachment(contentType as string, sizeBytes)
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
    console.log(JSON.stringify({ event: 'chat_updated', sub, chatId, fields: updatedFields }))
    return ok({ ok: true })
  }

  if (route === 'DELETE /api/chats/{chatId}') {
    const chat = await getChat(sub, chatId)
    if (!chat) return err(404, 'Not found')
    await deleteChat(sub, chatId)
    await deleteChatObjects(sub, chatId)
    console.log(JSON.stringify({ event: 'chat_deleted', sub, chatId }))
    return { statusCode: 204, body: '' }
  }

  if (route === 'POST /api/chats/{chatId}/retitle') {
    const chat = await getChat(sub, chatId)
    if (!chat) return err(404, 'Not found')
    const messages = await listMessages(chatId)
    if (messages.length === 0) return err(400, 'No messages to generate title from')
    const transcript = messages
      .slice(-10)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${(m.content as string).slice(0, 300)}`)
      .join('\n')
    const titlePrompt = `Generate a very short chat title (max 6 words) that captures the main topic of this conversation. Reply with ONLY the title, no quotes, no punctuation at the end.\n\n${transcript}`
    const title = await converseOnce(TITLE_MODEL, '', [
      { role: 'user', content: [{ text: titlePrompt }] },
    ])
    if (!title) return err(500, 'Title generation failed')
    await updateChatTitle(sub, chatId, title)
    return ok({ title })
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
    const newChatId = uuidv4()
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
      model: chat.model,
      systemPrompt: (chat.systemPrompt as string | undefined) ?? '',
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

    // Refuse to delete the root (no parent to reset activeLeafId to)
    if (targetRow.parentId === null) return err(400, 'Cannot delete the root message')

    const toDelete = subtreeMsgIds(rows, msgId)
    const toDeleteSet = new Set(toDelete)

    // Build PK+SK pairs for batch delete by looking up full keys in rows
    const keys = rows
      .filter(r => toDeleteSet.has(r.msgId))
      .map(r => ({ PK: r.PK, SK: r.SK }))

    await batchDeleteMessages(keys)

    // Reset activeLeafId if the active leaf is inside the deleted subtree.
    // Resolve to the leaf of the surviving branch under the same parent,
    // so the active path stays on a complete assistant response.
    const activeLeafId = chat.activeLeafId as string | undefined
    if (activeLeafId && toDeleteSet.has(activeLeafId)) {
      const remainingRows = rows.filter(r => !toDeleteSet.has(r.msgId))
      const newLeaf = resolveLeaf(remainingRows, targetRow.parentId)
      await updateChatActiveLeaf(sub, chatId, newLeaf)
    }

    console.log(JSON.stringify({ event: 'branch_deleted', sub, chatId, msgId, deletedCount: toDelete.length }))
    return { statusCode: 204, body: '' }
  }

  return err(404, 'Not found')
}
