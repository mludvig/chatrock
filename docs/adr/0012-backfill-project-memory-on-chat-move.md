# 12. Backfill project memory synchronously when a chat is moved into a project

## Status

Accepted

## Context

Moving an existing chat into a project (`PATCH /api/chats/{chatId}` with `projectId`) already backfills that chat's `summary`/`topics` via `summarizeChatById` (a synchronous extraction call, not waiting for the chat's next turn). Project *memory* (`enrichProjectFacts`) had no equivalent — a moved-in chat's prior history only ever reached project memory if the user sent a new message afterward, so a chat moved in and never touched again silently never contributed anything the project's other chats could see.

Alternatives considered:

1. **Do nothing — wait for the next turn.** Simplest, but leaves project memory silently incomplete for any chat that isn't revisited, which is exactly the reported symptom.
2. **Backfill synchronously in the PATCH handler**, mirroring `summarizeChatById`: read the chat's transcript, extract facts via `enrichProjectFacts` against the project's current memory, reconcile, and write. Adds Bedrock-call latency to the PATCH response but makes the move visibly complete.
3. **Backfill asynchronously (e.g. a queued job).** Avoids latency on the PATCH response, but this codebase has no async job infrastructure yet ([[0006]] cascade-delete streams are the closest analogue, and are a much bigger mechanism than this warrants) — introducing one for a single call site isn't justified.

## Decision

Option 2: `enrichProjectFactsByChatId(chatId, projectId)` in `backend/src/lib/enrichment.ts`, called from `http/chats.ts`'s PATCH handler right after `summarizeChatById`, only on a `null → projectId` transition (matching the existing `summarizeChatById` guard). Shares a new `buildChatTranscript` helper with `summarizeChatById` rather than duplicating the transcript-building logic a second time.

Guarded by the same rules that already gate passive enrichment in `ws/sendMessage.ts` (see "Sensitive & ephemeral chats" in `backend/CLAUDE.md`): skipped when `chat.sensitive`, and skipped when the target project's `memoryEnabled` is off.

## Consequences

- Moving a chat into a project now has the same one-time Bedrock-call latency for project memory that it already had for chat summary — one more Sonnet call added to that request, not a new pattern.
- A sensitive chat moved into a project still gets `summarizeChatById`'d (chat summary, unaffected by this ADR) but never contributes to project memory — consistent with every other project-fact write path.
- `enrichProjectFactsByChatId` never throws (matches every other function in `enrichment.ts`) — a failed backfill just means the user needs to send a message in that chat for memory to catch up, no worse than before this change.
