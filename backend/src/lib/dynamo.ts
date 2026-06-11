import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  BatchWriteCommand,
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

export async function updateChatModel(sub: string, chatId: string, model: string) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: buildChatKey(sub, chatId),
    UpdateExpression: 'SET #m = :m, updatedAt = :u',
    ExpressionAttributeNames: { '#m': 'model' },
    ExpressionAttributeValues: { ':m': model, ':u': new Date().toISOString() },
  }))
}

export async function deleteChat(sub: string, chatId: string) {
  // Delete all messages for this chat first (cascade)
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

export async function batchPutMessages(items: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25)
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [TABLE]: chunk.map(item => ({ PutRequest: { Item: item } })),
      },
    }))
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
