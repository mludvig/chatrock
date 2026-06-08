import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb'

export const TABLE = process.env.DYNAMO_TABLE ?? 'chatrock'

const raw = new DynamoDBClient({})
export const ddb = DynamoDBDocumentClient.from(raw)

export const buildChatKey = (sub: string, chatId: string) => ({
  PK: `USER#${sub}`,
  SK: `CHAT#${chatId}`,
})

export const buildMsgKey = (chatId: string, ts: string, msgId: string) => ({
  PK: `CHAT#${chatId}`,
  SK: `MSG#${ts}#${msgId}`,
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

export async function deleteChat(sub: string, chatId: string) {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: buildChatKey(sub, chatId),
  }))
}

export async function listMessages(chatId: string) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `CHAT#${chatId}`, ':prefix': 'MSG#' },
    ScanIndexForward: true,
  }))
  return res.Items ?? []
}

export async function putMessage(item: Record<string, unknown>) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }))
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
