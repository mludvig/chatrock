# 0040 — Concurrent per-chat streaming

## Status

Accepted. Supersedes `0022-per-chat-stream-identity.md`.

## Context

`0022` fixed the view/stream identity confusion but explicitly kept the composer
single-flight app-wide: `sending`, `streamingMsg`, the idle/ack watchdog timers, and the
DynamoDB stream-cancel flag were all still one global (or one-per-connection) piece of
state. That was fine while every turn finished in a few seconds to a couple of minutes —
but a deep-research turn (`0039`) can legitimately run for many minutes, and a user
starting one has no reason to be locked out of every other chat for that whole time.

The stream-cancel flag in particular lived on the `CONN#` row, keyed by `connId` — correct
when one connection could only ever have one turn in flight, wrong the moment two chats on
the same connection can both be streaming: cancelling one chat's turn would cancel
whichever chat happened to be currently streaming, not necessarily the one the user meant.

## Decision

- **Cancel and liveness state move to the chat row.** `setStreamCancel` /
  `isStreamCancelled` / `clearStreamCancel` now key on `(sub, chatId)`, not `connId` — a
  cancel request can only ever target the chat it was issued for, regardless of how many
  other chats are streaming on the same connection. `cancelMessage.ts`'s WS payload gains
  `chatId` accordingly.
- **Every WS frame is tagged with its `chatId`.** `sendMessage.ts`'s `safePost` stamps
  `chatId` onto every outgoing frame in one place, rather than at each of its ~20 call
  sites — the frontend's WS event router already threads `evt.chatId` through as the
  dispatch key, so a frame for a backgrounded chat updates that chat's own store slice
  without touching whatever chat is currently in view.
- **Frontend state that was global becomes per-chat.** `sendingByChat` / `streamingByChat`
  replace the single `sending` / `streamingMsg` fields in `chatStore.ts`; `ChatView.tsx`'s
  idle-timer, ack-watchdog, and streaming-base-message refs become `Record<chatId, ...>`
  instead of single refs. Everything that reads or writes this state now does so through
  the chatId it actually concerns, not implicitly "the current chat."
- **Only the viewed chat's UI reacts to a frame.** Store updates happen for every chat's
  frames regardless of which is viewed, but UI-only effects (the countdown banner,
  sub-agent narration text, scrolling) are gated on `evt.chatId === chatIdRef.current` —
  a background chat's turn keeps progressing in the store without painting into the
  wrong view.
- **The reconnect-chase decision now considers every chat.** `ws.ts`'s `setTurnInFlight`
  is driven by "is *any* chat sending," not just the viewed one — a background chat's
  in-flight turn still deserves the same aggressive reconnect-with-backoff behavior as a
  foreground one.

## Consequences

- A user can start a deep-research turn, navigate away, and send a message in a different
  chat while the first keeps streaming in the background — returning to it later shows
  the complete, correctly-ordered answer via the same cache-invalidation path `0022`
  already built for "stream finished while viewing elsewhere."
- Stop and cancel are now unambiguously scoped to one chat — cancelling chat A can never
  abort chat B's turn on the same connection, closing the class of bug this ADR started
  from.
- The composer/draft-recovery UX in `handleAckTimeout` (restoring typed content, deleting
  an orphaned new chat) is still scoped to a single tab's most recent send — that state
  was never per-chat and doesn't need to be, since only one send can be "the thing the user
  just typed" at a time.
- Every future piece of stream-related state needs to ask "per-chat, or genuinely global?"
  before being added — the answer was uniformly "per-chat" here, but that's not
  automatically enforced by the type system.
