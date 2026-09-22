/**
 * Sorts by recent activity (lastMessageAt desc, falling back to createdAt).
 * updatedAt is deliberately ignored: it moves on any metadata edit (rename, project move,
 * flags), which must not reorder the list. See
 * docs/adr/0049-sort-chats-by-last-message-and-save-composer-choices-on-send.md.
 * Backend lists (files, memories, projects) already come back newest-first
 * for free via ULID sort keys (see backend/src/lib/ids.ts) — this helper is
 * only needed where "recent activity" should win over "recently created",
 * i.e. chat lists, where a chat can be touched long after it was made.
 */
export function lastActivity(item: { lastMessageAt?: string; createdAt?: string }): string {
  return item.lastMessageAt ?? item.createdAt ?? new Date(0).toISOString()
}

export function sortByRecent<T extends { lastMessageAt?: string; createdAt?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => Date.parse(lastActivity(b)) - Date.parse(lastActivity(a)))
}
