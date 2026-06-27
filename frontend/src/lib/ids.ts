import { ulid } from 'ulid'

/**
 * Generates a chatId for the optimistic client-side new-chat flow (see
 * ChatView.tsx's pendingNewChatIdRef — attachments need a chatId before the
 * chat exists server-side). This is the ONLY place that may import the
 * `ulid` package — every other call site must import `newId` from here.
 *
 * Must mirror backend/src/lib/ids.ts exactly: the backend's CHAT# sort key
 * is lexicographically sortable only if every chatId in the system shares
 * one case (lowercase). A client-supplied id that doesn't match
 * newId()'s shape is rejected by POST /api/chats (see http/chats.ts's
 * ULID_RE check) rather than silently breaking that invariant.
 */
export function newId(): string {
  return ulid().toLowerCase()
}
