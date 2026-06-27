/**
 * Sorts by recent activity (updatedAt desc, falling back to createdAt).
 * Backend lists (files, memories, projects) already come back newest-first
 * for free via ULID sort keys (see backend/src/lib/ids.ts) — this helper is
 * only needed where "recent activity" should win over "recently created",
 * i.e. chat lists, where a chat can be touched long after it was made.
 */
export function sortByRecent<T extends { updatedAt?: string; createdAt?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const at = new Date(a.updatedAt ?? a.createdAt ?? 0).getTime()
    const bt = new Date(b.updatedAt ?? b.createdAt ?? 0).getTime()
    return bt - at
  })
}
