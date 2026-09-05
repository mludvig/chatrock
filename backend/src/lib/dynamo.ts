import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  BatchWriteCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'

export const TABLE = process.env.DYNAMO_TABLE ?? 'chatrock'

const raw = new DynamoDBClient({})
export const ddb = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } })

export const buildChatKey = (sub: string, chatId: string) => ({
  PK: `USER#${sub}`,
  SK: `CHAT#${chatId}`,
})

export const buildMsgKey = (chatId: string, ts: string, msgId: string) => ({
  PK: `CHAT#${chatId}`,
  SK: `MSG#${ts}#${msgId}`,
})

/**
 * Key for a per-Converse-turn record (format C).
 *
 * SK: MSG#<responseStartTs>#<seqPadded4>#<msgId>
 *
 * Zero-padded seq ensures lexical sort == turn order even when multiple turns
 * share the same millisecond timestamp.  All turns of one response share the
 * same `ts` (captured once at response start), so they sort together and in
 * order, before any later response.
 */
export const buildTurnKey = (chatId: string, ts: string, seq: number, msgId: string) => ({
  PK: `CHAT#${chatId}`,
  SK: `MSG#${ts}#${String(seq).padStart(4, '0')}#${msgId}`,
})

export const buildConnKey = (connId: string) => ({
  PK: `CONN#${connId}`,
  SK: `CONN#${connId}`,
})

export async function listChats(sub: string) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `USER#${sub}`, ':prefix': 'CHAT#' },
    ScanIndexForward: false,
  }))
  return res.Items ?? []
}

export async function getChat(sub: string, chatId: string) {
  const res = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: buildChatKey(sub, chatId),
  }))
  return res.Item
}

export async function putChat(item: Record<string, unknown>) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }))
}

export async function updateChatTitle(sub: string, chatId: string, title: string) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: buildChatKey(sub, chatId),
    UpdateExpression: 'SET title = :t, updatedAt = :u',
    ExpressionAttributeValues: { ':t': title, ':u': new Date().toISOString() },
  }))
}

export async function updateChatSystemPrompt(sub: string, chatId: string, systemPrompt: string) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: buildChatKey(sub, chatId),
    UpdateExpression: 'SET systemPrompt = :sp, updatedAt = :u',
    ExpressionAttributeValues: { ':sp': systemPrompt, ':u': new Date().toISOString() },
  }))
}

export async function updateChatActiveLeaf(sub: string, chatId: string, activeLeafId: string) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: buildChatKey(sub, chatId),
    UpdateExpression: 'SET activeLeafId = :a, updatedAt = :u',
    ExpressionAttributeValues: { ':a': activeLeafId, ':u': new Date().toISOString() },
  }))
}

// A turn is streaming for this chat right now. The client can't learn this any other way:
// the answer is persisted only as each round completes, and the WS frames went to a
// connection that may be long gone. See docs/adr/0037-catching-up-on-a-dropped-stream.md.
// `deadlineAt` (epoch ms) is set only for a deep turn — its presence is itself the gate the
// frontend uses to decide whether to render a countdown, so a brief/extended turn never shows
// a stale or misleading one.
export async function setChatStreaming(sub: string, chatId: string, responseId: string, deadlineAt?: number) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: buildChatKey(sub, chatId),
    UpdateExpression: deadlineAt !== undefined
      ? 'SET streamingSince = :s, streamingResponseId = :r, streamingDeadlineAt = :d'
      : 'SET streamingSince = :s, streamingResponseId = :r',
    ExpressionAttributeValues: deadlineAt !== undefined
      ? { ':s': new Date().toISOString(), ':r': responseId, ':d': deadlineAt }
      : { ':s': new Date().toISOString(), ':r': responseId },
  }))
}

export async function clearChatStreaming(sub: string, chatId: string) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: buildChatKey(sub, chatId),
    UpdateExpression: 'REMOVE streamingSince, streamingResponseId, streamingDeadlineAt',
  }))
}

export async function updateChatModel(sub: string, chatId: string, model: string) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: buildChatKey(sub, chatId),
    UpdateExpression: 'SET #m = :m, updatedAt = :u',
    ExpressionAttributeNames: { '#m': 'model' },
    ExpressionAttributeValues: { ':m': model, ':u': new Date().toISOString() },
  }))
}

export async function updateChatModelSettings(sub: string, chatId: string, modelSettings: Record<string, unknown>) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: buildChatKey(sub, chatId),
    UpdateExpression: 'SET modelSettings = :ms, updatedAt = :u',
    ExpressionAttributeValues: { ':ms': modelSettings, ':u': new Date().toISOString() },
  }))
}

// Toggles the `sensitive` flag. Cleared (not just set false) when turning it off, so a
// chatDto() read never has to special-case a stale `false` vs. absent. `sensitive` is a
// DynamoDB reserved keyword — must go through ExpressionAttributeNames or every call 400s.
export async function updateChatSensitive(sub: string, chatId: string, sensitive: boolean) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: buildChatKey(sub, chatId),
    UpdateExpression: sensitive ? 'SET #s = :s, updatedAt = :u' : 'REMOVE #s SET updatedAt = :u',
    ExpressionAttributeNames: { '#s': 'sensitive' },
    ExpressionAttributeValues: sensitive ? { ':s': true, ':u': new Date().toISOString() } : { ':u': new Date().toISOString() },
  }))
}

// Toggles the `ephemeral` flag (+ `ttl`). Turning it on stamps a FRESH ttl from now — never
// resurrects whatever ttl the chat may have had before. Turning it off removes both attributes
// so DynamoDB's TTL sweep no longer considers the item, and chatDto() has nothing stale to read.
// `ttl` is also a DynamoDB reserved keyword.
export async function updateChatEphemeral(sub: string, chatId: string, ephemeral: boolean, ttlSeconds?: number) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: buildChatKey(sub, chatId),
    UpdateExpression: ephemeral ? 'SET ephemeral = :e, #t = :t, updatedAt = :u' : 'REMOVE ephemeral, #t SET updatedAt = :u',
    ExpressionAttributeNames: { '#t': 'ttl' },
    ExpressionAttributeValues: ephemeral
      ? { ':e': true, ':t': Math.floor(Date.now() / 1000) + (ttlSeconds ?? 604800), ':u': new Date().toISOString() }
      : { ':u': new Date().toISOString() },
  }))
}

// Deletes all Message items under CHAT#<chatId>. Split out from deleteChat so the
// stream-triggered cascade cleanup Lambda (streams/chatTtlCleanup.ts) can reuse exactly this
// — it fires *after* the Chat item is already gone (that REMOVE event is what triggers it),
// so it must never re-attempt deleting the Chat item itself.
export async function deleteChatMessages(chatId: string) {
  const msgs = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `CHAT#${chatId}`, ':prefix': 'MSG#' },
    ProjectionExpression: 'PK, SK',
  }))
  const items = msgs.Items ?? []
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25)
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [TABLE]: chunk.map(item => ({ DeleteRequest: { Key: { PK: item.PK, SK: item.SK } } })),
      },
    }))
  }
}

// Deletes only the Chat item. Message + S3 cleanup is NOT done here — it's handled by the
// stream-triggered cascade cleanup Lambda (streams/chatTtlCleanup.ts), which fires off this
// item's DynamoDB Stream REMOVE event. Used both for manual delete (DELETE /api/chats/{chatId})
// and implicitly for TTL expiry (DynamoDB's own background TTL sweep issues the same REMOVE).
export async function deleteChatItem(sub: string, chatId: string) {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: buildChatKey(sub, chatId),
  }))
}

export async function listMessages(chatId: string) {
  const items: Record<string, unknown>[] = []
  let lastKey: Record<string, unknown> | undefined

  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `CHAT#${chatId}`, ':prefix': 'MSG#' },
      ScanIndexForward: true,
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }))
    for (const item of res.Items ?? []) items.push(item as Record<string, unknown>)
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastKey)

  return items
}

export async function putMessage(item: Record<string, unknown>) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }))
}

// Writes an assistant turn (with toolUse blocks) and its tool-result turn atomically — both
// land or neither does. Prevents the active path from ever ending on a dangling tool_use:
// a failure (size limit, throttling, etc.) leaves the PRIOR turn as the durable tip instead
// of a structurally-connected-but-Bedrock-invalid one.
export async function putMessagePair(assistantItem: Record<string, unknown>, toolResultItem: Record<string, unknown>) {
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: TABLE, Item: assistantItem } },
      { Put: { TableName: TABLE, Item: toolResultItem } },
    ],
  }))
}

// BatchWriteCommand is not atomic and can return UnprocessedItems (e.g. under throttling)
// without throwing. Retrying them is the difference between "fork copied every message" /
// "subtree fully deleted" and a silent partial result that looks identical until something
// downstream trips over the gap. Throws if items remain unprocessed after all retries so the
// caller's error handling (not a silent partial success) is what runs.
async function sendBatchWriteWithRetry(requests: Record<string, unknown>[], maxAttempts = 5): Promise<void> {
  let pending = requests
  for (let attempt = 0; attempt < maxAttempts && pending.length > 0; attempt++) {
    const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: pending } }))
    pending = (res.UnprocessedItems?.[TABLE] as Record<string, unknown>[] | undefined) ?? []
    if (pending.length > 0 && attempt < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, 2 ** attempt * 50))
    }
  }
  if (pending.length > 0) {
    throw new Error(`BatchWriteCommand: ${pending.length} item(s) still unprocessed after ${maxAttempts} attempts`)
  }
}

export async function batchPutMessages(items: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25)
    await sendBatchWriteWithRetry(chunk.map(item => ({ PutRequest: { Item: item } })))
  }
}

export async function batchDeleteMessages(keys: { PK: string; SK: string }[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    const chunk = keys.slice(i, i + 25)
    await sendBatchWriteWithRetry(chunk.map(k => ({ DeleteRequest: { Key: { PK: k.PK, SK: k.SK } } })))
  }
}

export async function putConnection(item: Record<string, unknown>) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }))
}

export async function getConnection(connId: string) {
  const res = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: buildConnKey(connId),
  }))
  return res.Item
}

export async function deleteConnection(connId: string) {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: buildConnKey(connId),
  }))
}

export async function setStreamCancel(connId: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: buildConnKey(connId),
    UpdateExpression: 'SET cancelRequested = :v',
    ExpressionAttributeValues: { ':v': true },
  }))
}

export async function isStreamCancelled(connId: string): Promise<boolean> {
  const res = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: buildConnKey(connId),
  }))
  return res.Item?.cancelRequested === true
}

export async function clearStreamCancel(connId: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: buildConnKey(connId),
    UpdateExpression: 'REMOVE cancelRequested',
  }))
}

export const buildUserPrefKey = (sub: string) => ({
  PK: `USER#${sub}`,
  SK: 'PREF#USER',
})

export async function getUserPrefs(sub: string): Promise<Record<string, unknown>> {
  const res = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: buildUserPrefKey(sub),
  }))
  return (res.Item?.prefs as Record<string, unknown>) ?? {}
}

export async function putUserPrefs(sub: string, prefs: Record<string, unknown>): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      ...buildUserPrefKey(sub),
      prefs,
      updatedAt: new Date().toISOString(),
    },
  }))
}

export const buildUserMemKey = (sub: string, memId: string) => ({
  PK: `USER#${sub}`,
  SK: `MEM#USER#${memId}`,
})

export async function listUserMemories(sub: string) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `USER#${sub}`, ':prefix': 'MEM#USER#' },
    ScanIndexForward: true,
  }))
  return res.Items ?? []
}

export async function putUserMemory(item: Record<string, unknown>): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }))
}

export async function deleteUserMemory(sub: string, memId: string): Promise<void> {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: buildUserMemKey(sub, memId),
  }))
}

export async function updateUserMemory(
  sub: string,
  memId: string,
  fields: Partial<{ text: string; category: string; updatedAt: string }>,
) {
  const updates = Object.entries({ ...fields, updatedAt: new Date().toISOString() })
    .filter(([, v]) => v !== undefined)
  if (updates.length === 0) return
  const sets = updates.map(([_k], i) => `#f${i} = :v${i}`)
  const names = Object.fromEntries(updates.map(([k], i) => [`#f${i}`, k]))
  const values = Object.fromEntries(updates.map(([, v], i) => [`:v${i}`, v]))
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: buildUserMemKey(sub, memId),
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }))
}

// Project key builders
export const buildProjectKey = (sub: string, projectId: string) => ({
  PK: `USER#${sub}`,
  SK: `PROJECT#${projectId}`,
})

export const buildProjectMemKey = (projectId: string, memId: string) => ({
  PK: `PROJECT#${projectId}`,
  SK: `MEM#${memId}`,
})

export const buildProjectFileKey = (projectId: string, fileId: string) => ({
  PK: `PROJECT#${projectId}`,
  SK: `FILE#${fileId}`,
})

// Project CRUD
export async function listProjects(sub: string) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `USER#${sub}`, ':prefix': 'PROJECT#' },
    ScanIndexForward: false,
  }))
  return res.Items ?? []
}

export async function getProject(sub: string, projectId: string) {
  const res = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: buildProjectKey(sub, projectId),
  }))
  return res.Item
}

export async function putProject(item: Record<string, unknown>) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }))
}

export async function updateProjectFields(
  sub: string,
  projectId: string,
  fields: Partial<{
    name: string
    description: string
    instructions: string
    memoryEnabled: boolean
    defaultModel: string
    modelSettings: Record<string, unknown>
    updatedAt: string
  }>,
): Promise<void> {
  const updates: string[] = []
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = {}

  const fieldMap: Record<string, string> = {
    name: 'name',
    description: 'description',
    instructions: 'instructions',
    memoryEnabled: 'memoryEnabled',
    defaultModel: 'defaultModel',
    modelSettings: 'modelSettings',
  }

  for (const [key, value] of Object.entries(fields)) {
    if (key === 'updatedAt') continue
    if (key in fieldMap) {
      const alias = `#${key}`
      names[alias] = fieldMap[key]
      values[`:${key}`] = value
      updates.push(`${alias} = :${key}`)
    }
  }

  // Always set updatedAt
  updates.push('#updatedAt = :updatedAt')
  names['#updatedAt'] = 'updatedAt'
  values[':updatedAt'] = new Date().toISOString()

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: buildProjectKey(sub, projectId),
    UpdateExpression: `SET ${updates.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }))
}

export async function deleteProject(sub: string, projectId: string) {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: buildProjectKey(sub, projectId),
  }))
}

// Chat project membership
export async function updateChatProject(
  sub: string,
  chatId: string,
  projectId: string | null,
): Promise<void> {
  if (projectId === null) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: buildChatKey(sub, chatId),
      UpdateExpression: 'REMOVE projectId SET updatedAt = :u',
      ExpressionAttributeValues: { ':u': new Date().toISOString() },
    }))
  } else {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: buildChatKey(sub, chatId),
      UpdateExpression: 'SET projectId = :p, updatedAt = :u',
      ExpressionAttributeValues: { ':p': projectId, ':u': new Date().toISOString() },
    }))
  }
}

export async function updateChatSummary(
  sub: string,
  chatId: string,
  fields: { summary?: string; topics?: string[] },
): Promise<void> {
  const sets: string[] = []
  const values: Record<string, unknown> = {}
  if (fields.summary !== undefined) { sets.push('summary = :s'); values[':s'] = fields.summary }
  if (fields.topics !== undefined) { sets.push('topics = :t'); values[':t'] = fields.topics }
  if (sets.length === 0) return
  // intentionally omits updatedAt to avoid reordering the chat list
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: buildChatKey(sub, chatId),
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeValues: values,
  }))
}

// ── Project files ─────────────────────────────────────────────────────────────

export async function listProjectFiles(projectId: string) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `PROJECT#${projectId}`, ':prefix': 'FILE#' },
  }))
  return (result.Items ?? []) as Record<string, unknown>[]
}

export async function getProjectFile(projectId: string, fileId: string) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: buildProjectFileKey(projectId, fileId),
  }))
  return result.Item as Record<string, unknown> | undefined
}

export async function putProjectFile(item: Record<string, unknown>) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }))
}

export async function updateProjectFile(
  projectId: string,
  fileId: string,
  fields: Partial<{
    status: string
    microLabel: string
    summary: string
    extractedTextKey: string
    inclusion: string
    updatedAt: string
  }>,
) {
  const updates = Object.entries({ ...fields, updatedAt: new Date().toISOString() })
    .filter(([, v]) => v !== undefined)
  if (updates.length === 0) return
  const sets = updates.map(([_k], i) => `#f${i} = :v${i}`)
  const names = Object.fromEntries(updates.map(([k], i) => [`#f${i}`, k]))
  const values = Object.fromEntries(updates.map(([, v], i) => [`:v${i}`, v]))
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: buildProjectFileKey(projectId, fileId),
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }))
}

export async function deleteProjectFile(projectId: string, fileId: string) {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: buildProjectFileKey(projectId, fileId),
  }))
}

// ── Project memory ─────────────────────────────────────────────────────────────

export async function listProjectMemories(projectId: string) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `PROJECT#${projectId}`, ':prefix': 'MEM#' },
  }))
  return (result.Items ?? []) as Record<string, unknown>[]
}

export async function putProjectMemory(item: Record<string, unknown>): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }))
}

export async function updateProjectMemory(
  projectId: string,
  memId: string,
  fields: Partial<{ text: string; category: string; updatedAt: string }>,
) {
  const updates = Object.entries({ ...fields, updatedAt: new Date().toISOString() })
    .filter(([, v]) => v !== undefined)
  if (updates.length === 0) return
  const sets = updates.map(([_k], i) => `#f${i} = :v${i}`)
  const names = Object.fromEntries(updates.map(([k], i) => [`#f${i}`, k]))
  const values = Object.fromEntries(updates.map(([, v], i) => [`:v${i}`, v]))
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: buildProjectMemKey(projectId, memId),
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }))
}

export async function deleteProjectMemory(projectId: string, memId: string): Promise<void> {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: buildProjectMemKey(projectId, memId),
  }))
}

// Generic batch delete (reusable for cascading deletes)
export async function batchDeleteKeys(keys: { PK: string; SK: string }[]): Promise<void> {
  return batchDeleteMessages(keys)
}

// ── Chat shares (read-only public links) ───────────────────────────────────────
//
// Two items per share, written/deleted together (never one without the other):
//   - Lookup item: PK=SHARE#<shareId> / SK=SHARE#<shareId> — the ONLY key the public,
//     unauthenticated /s/{shareId} renderer has available (no sub, no chatId to key off).
//     Carries `sub` + `chatId` so the renderer can call getChat(sub, chatId) as its ownership
//     gate; a deleted chat then 404s with no content leak.
//   - Owner index item: PK=CHAT#<chatId> / SK=SHARE#<shareId> — lets the authenticated owner
//     list/revoke shares for one chat without a table scan or GSI.
export const buildShareLookupKey = (shareId: string) => ({
  PK: `SHARE#${shareId}`,
  SK: `SHARE#${shareId}`,
})

export const buildShareIndexKey = (chatId: string, shareId: string) => ({
  PK: `CHAT#${chatId}`,
  SK: `SHARE#${shareId}`,
})

export async function putSharePair(lookupItem: Record<string, unknown>, indexItem: Record<string, unknown>) {
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: TABLE, Item: lookupItem } },
      { Put: { TableName: TABLE, Item: indexItem } },
    ],
  }))
}

export async function getShare(shareId: string) {
  const res = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: buildShareLookupKey(shareId),
  }))
  return res.Item
}

export async function listChatShares(chatId: string) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `CHAT#${chatId}`, ':prefix': 'SHARE#' },
    ScanIndexForward: false,
  }))
  return res.Items ?? []
}

export async function deleteSharePair(chatId: string, shareId: string) {
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Delete: { TableName: TABLE, Key: buildShareLookupKey(shareId) } },
      { Delete: { TableName: TABLE, Key: buildShareIndexKey(chatId, shareId) } },
    ],
  }))
}

// Cascade cleanup for a deleted chat's shares (streams/chatTtlCleanup.ts): removes both the
// CHAT#<chatId>/SHARE# index items and their SHARE#<shareId> lookup partners. Without this,
// a deleted chat's stale lookup items would linger — harmlessly 404ing forever (getChat gate
// in http/share.ts), but never actually freed — so this keeps the table from accumulating them.
export async function deleteChatShares(chatId: string): Promise<void> {
  const shares = await listChatShares(chatId)
  if (shares.length === 0) return
  const keys = shares.flatMap(s => [
    { PK: s.PK as string, SK: s.SK as string },
    buildShareLookupKey(s.shareId as string),
  ])
  await batchDeleteMessages(keys)
}
