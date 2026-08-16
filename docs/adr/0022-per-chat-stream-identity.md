# 22. Per-chat stream identity

## Status

Accepted

## Context

`chatStore.ts` models the in-flight turn with three global fields — `messages`,
`streamingMsg`, `sending` — with no chatId tag anywhere. `ChatView.tsx` was written
assuming the chat currently *viewed* and the chat currently *streaming* are always the
same chat. That held until a user actually switched chats mid-stream (reported live):
navigating away didn't switch the view at all (the messages-load effect bailed on the
global `sending` flag before even checking its own cache), and navigating back later
showed a permanently cut-off answer — the WS handler's `done`/`error` branches reloaded
whatever chat was *currently viewed* (`chatIdRef.current`), not the chat the stream
actually belonged to, so the streaming chat's cache was never refreshed with the finished
answer. Only a full page reload (which bypasses the stale cache) revealed the complete
answer.

## Decision

- **`streamingChatIdRef`**, a ref in `ChatView.tsx`, tracks which chatId the in-flight
  turn belongs to, set at every `startStream()` call site (new-chat/edit/normal-send in
  `handleSend`, plus `handleRerun`/`handleContinue`) and cleared when that turn finishes.
  This is the one addition needed to disambiguate "viewed" from "streaming" everywhere
  else already assumed they matched.
- **Not concurrent multi-chat streaming.** `sending` stays a single global flag — the
  composer still can't start a second turn while one is in flight anywhere. This is
  scoped down to fixing the two reported symptoms (view doesn't switch; returning shows
  stale content), not a redesign to support truly parallel per-chat streams.
- **Gated on `streamingChatIdRef.current === chatId`**: the messages-load effect's
  sending-guard (so navigating to an unrelated chat isn't blocked by some other chat
  streaming), `allMessages`'s inclusion of the global `streamingMsg` bubble (so it only
  renders in the chat it belongs to), the refocus-catchup handler (so refocusing on an
  unrelated chat doesn't force-finalize someone else's stream), and the composer's
  Stop/Send toggle (so Stop never cancels a different chat's answer — a disabled Stop
  icon is shown instead, since the composer is still globally locked while any stream is
  active).
- **`invalidateMessagesCache(chatId)`**, a new store action, is used in the WS handler's
  `done`/`cancelled`/`error` branches: when the finishing stream's chat differs from the
  chat currently viewed, its cache is evicted instead of reloaded, so the next visit does
  a fresh `GET /messages` fetch rather than serving stale/incomplete cached content.

## Consequences

- Switching chats mid-stream now updates the view immediately, and returning to the
  streaming chat later shows the complete answer without a manual reload.
- The composer remains single-flight app-wide; a second chat cannot be sent to while
  another streams. Lifting that restriction (true parallel streams) is out of scope here.
- Every future `startStream()` call site must remember to set `streamingChatIdRef.current`
  first — there's no static enforcement of that pairing.
