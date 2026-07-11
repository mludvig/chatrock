import type { DynamoDBStreamEvent } from 'aws-lambda'
import { deleteChatMessages } from '../lib/dynamo'
import { deleteChatObjects } from '../lib/attachments'

// Cascade-delete cleanup for chats. Triggered by the DynamoDB Stream (event source mapping's
// filter_criteria restricts this to Chat-item REMOVE events — see terraform/stream_chat_cleanup.tf)
// on both manual DELETE /api/chats/{chatId} (http/chats.ts only deletes the Chat item itself) and
// TTL expiry of a private chat. One cascade implementation instead of two. See "Chat deletion &
// temporary/private chats" in backend/CLAUDE.md for the full design rationale.
export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  for (const record of event.Records) {
    const keys = record.dynamodb?.Keys
    const pk = keys?.PK?.S
    const sk = keys?.SK?.S
    if (!pk?.startsWith('USER#') || !sk?.startsWith('CHAT#')) continue // belt-and-braces; the event source filter already restricts to this

    const sub = pk.slice('USER#'.length)
    const chatId = sk.slice('CHAT#'.length)

    try {
      await deleteChatMessages(chatId)
      await deleteChatObjects(sub, chatId)
      console.log(JSON.stringify({ event: 'chat_cleanup_cascaded', sub, chatId }))
    } catch (err) {
      console.error(JSON.stringify({ event: 'chat_cleanup_error', sub, chatId, error: String(err) }))
      throw err // let the event source mapping's retry/DLQ policy handle it
    }
  }
}
