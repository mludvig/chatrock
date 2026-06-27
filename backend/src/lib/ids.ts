import { ulid } from 'ulid'

/**
 * Generates the ID for anything that becomes a DynamoDB sort key
 * (chatId, projectId, fileId, memId). This is the ONLY place that may
 * import the `ulid` package — every other call site must import `newId`
 * from here, never `ulid` directly.
 *
 * Why: ULIDs are lexicographically sortable by creation time (the first
 * 48 bits are a millisecond timestamp), so `ScanIndexForward: false`
 * queries (listChats, listProjects, ...) return newest-first for free,
 * with no client-side sort and no GSI.
 *
 * Why lowercased: that sort guarantee only holds if every ID in the
 * system shares one case — ASCII 'A'-'Z' sorts before 'a'-'z', so a
 * single uppercase ID would interleave out of order with the rest.
 * Funnelling generation through this wrapper is what keeps that
 * invariant true everywhere, including IDs a client supplies (see the
 * chatId validation in http/chats.ts).
 */
export function newId(): string {
  return ulid().toLowerCase()
}
