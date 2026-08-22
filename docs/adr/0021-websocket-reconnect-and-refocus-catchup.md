# 21. WebSocket reconnect and refocus catch-up

## Status

Accepted

## Context

On iOS, backgrounding the tab closes the WebSocket outright. The backend was already
correct here — `safePost` sets `connectionGone` on a 410 and keeps streaming to
completion, and `activeLeafId` advances after every turn write
(`ws/sendMessage.ts:76-89, 111-115`) — so by the time the user returns the answer is fully
persisted. The frontend simply never reconnected or refetched: `ws.ts`'s `onclose` just
nulled the socket, and nothing listened for the tab becoming visible again, so the chat sat
on a stale streaming bubble forever.

## Decision

- **Reconnect with backoff, but only while a turn is in flight.** `ws.ts` gained a
  `turnInFlight` flag, set by `ChatView` via `setTurnInFlight()` mirroring its `sending`
  store flag. An unexpected `onclose` reconnects (1s, 2s, 4s… capped at 10s) only when
  `turnInFlight` is true; an idle drop is left alone and reconnects lazily on the next
  `ensureConnected()` call before a send, same as today. This avoids a live socket
  chasing a server-side idle timeout every time the tab sits in the background doing
  nothing.
- **A `ConnectionState` callback (`'open' | 'connecting' | 'closed'`), not a store field.**
  `ws.ts` stays decoupled from `chatStore` (which already imports a type from `ws.ts`, so a
  runtime import back would be circular); `ChatView` subscribes via
  `setConnectionStateHandler()` into local state and shows a "Reconnecting…" banner only
  while `'connecting'`.
- **Refocus is a refetch, not a resend.** A `visibilitychange`/`focus` listener in
  `ChatView` calls `ensureConnected()` and, if `sending` was still true, refetches
  `GET /messages` for the active chat and reconciles — no server-side work, since the
  answer is already there. `reloadMessages()` gained a `force` option that bypasses its
  existing sending-guard and clears the stream/sending state itself, since here there is no
  live stream to protect, just a stale local view.
- **A Deep Research run counts as in flight, and reconciles from its run row.** A run executes
  in Step Functions with `sending` already false, so neither the reconnect flag nor the
  `sending`-gated refetch above would cover it, and its best-effort `research_done` frame is
  simply lost if the phone is away when it fires. `ChatView` therefore mirrors
  `sending || activeResearchRun` into `setTurnInFlight()`, and refocus additionally re-reads
  `GET /api/chats/{chatId}/research` whenever the current chat has an active run — the `RUN#`
  row, not the frame, is the source of truth. A `done`/`failed` run clears the progress panel
  and reloads the transcript; a missing run row is left alone, since `startResearch` seeds the
  panel optimistically before the row exists.
- **Squares with the existing ack watchdog** (`armAckWatchdog`): that covers "the send
  never landed" (no `ack` frame within 12s); this covers "the send landed and the turn
  finished while we were away." Different failure, different recovery — watchdog discards
  the optimistic bubble and asks the user to resend, refocus catch-up just reconciles to
  what the server already has.

## Consequences

- No backend changes were needed — this is entirely a frontend-side recovery for
  server-side work that was already correct.
- The reconnect backoff is unbounded in attempt count (only the delay is capped at 10s) as
  long as `turnInFlight` stays true — acceptable since a turn either finishes (clearing
  `sending`) or the user eventually gives up and reloads; there's no separate max-attempts
  ceiling like the initial `connect()`'s 3-try cold-start path.
- The "Reconnecting…" banner reuses `.error-banner.warning` (no new banner style) and has
  no dismiss button — it clears itself the moment `onopen` or a clean `disconnect()` fires.
