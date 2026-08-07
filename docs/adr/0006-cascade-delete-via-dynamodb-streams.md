# 6. Cascade-delete via DynamoDB Streams, not synchronously in the handler

## Status

Accepted

## Context

Deleting a chat needs to remove its Message items and S3 attachments too, not just the Chat record. Ephemeral chats need the identical cleanup to happen automatically on TTL expiry. Two distinct trigger events (an explicit `DELETE /api/chats/{chatId}` call, and DynamoDB's own background TTL sweep) need the same cascade behavior.

Alternatives considered:

1. **Synchronous cascade in the DELETE handler.** `http/chats.ts` deletes the Chat item, then queries and deletes all Message items and S3 objects, all within the request. Works for a manual delete, but DynamoDB's background TTL sweep doesn't invoke application code directly — a second, separate cleanup mechanism (e.g. a scheduled scan for expired chats) would be needed just for expiry, duplicating the cascade logic and risking the two implementations drifting apart.
2. **DynamoDB Streams-triggered cascade.** `DELETE /api/chats/{chatId}` only deletes the Chat item itself (`dynamo.ts`'s `deleteChatItem`). The table's Stream (`stream_view_type = KEYS_ONLY`) emits a `REMOVE` event — identical in shape whether the deletion was manual or from TTL expiry — which triggers `stream_chat_cleanup` (`streams/chatTtlCleanup.ts`) to do the actual cascade: Message items, S3 attachments, shares. The event source mapping's `filter_criteria` restricts invocation to Chat-item `REMOVE` events specifically (`PK` prefix `USER#`, `SK` prefix `CHAT#`), so a Message-item removal from within the cascade itself can never re-trigger it.

## Decision

Option 2 — one cascade implementation instead of two, since DynamoDB's own TTL sweep produces the same `REMOVE` event shape as an explicit delete.

## Consequences

- Accepted eventual-consistency window: for a few seconds after a manual delete, that chat's messages are still fetchable by direct URL/API, until the stream event fires and cleanup runs.
- Ephemeral-chat expiry inherits DynamoDB TTL's own documented ~48h fuzziness (AWS does not guarantee prompt deletion of expired items) — acceptable for "this chat disappears eventually," not acceptable if a hard deletion-timing SLA were ever required.
- On-failure destination is `chat_cleanup_dlq` (SQS, 3 retries then DLQ, 14-day retention) — a transient S3/DynamoDB error during cascade lands in a replayable queue instead of silently orphaning data, but a failed-and-unretried cascade does leave orphaned Message items/S3 objects until someone notices the DLQ depth alarm and replays it.
