/**
 * Reconciles a fetched chat list with the store, which may have changed while the request
 * was in flight. `knownAtStart` is the set of chatIds in the store when the request began.
 * A chat added locally since then (created in this tab) is kept even though the response
 * predates it; a chat removed locally since then stays removed. Anything else follows the
 * server. See docs/adr/0060-reconcile-fetched-chat-list-with-local-changes.md.
 */
export function mergeFetchedChats<T extends { chatId: string }>(
  fetched: T[],
  current: T[],
  knownAtStart: ReadonlySet<string>,
): T[] {
  const currentIds = new Set(current.map(c => c.chatId))
  const fetchedIds = new Set(fetched.map(c => c.chatId))
  const addedLocally = current.filter(c => !knownAtStart.has(c.chatId) && !fetchedIds.has(c.chatId))
  const kept = fetched.filter(c => !knownAtStart.has(c.chatId) || currentIds.has(c.chatId))
  return [...addedLocally, ...kept]
}
