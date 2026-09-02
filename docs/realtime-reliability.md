# Real-time reliability on intermittently connected clients

Chatrock streams answers over an API Gateway WebSocket to browsers that are frequently
phones: backgrounded mid-turn, asleep past a token's lifetime, resumed on a different
network hours later. Every outage this app has had in that area came back to the same
handful of mistakes. This note is the general rule behind them, so the next real-time
feature starts from the conclusion rather than rediscovering it.

The decisions themselves live in `docs/adr/` — 0021 (reconnect and refocus catch-up), 0022
(per-chat stream identity), 0027 (research progress frames), 0036 (token read at connect),
0037 (catch-up is a refetch). This is the reasoning they share.

## The premise

**The connection is a transport optimisation, not the source of truth.** A WebSocket makes
an answer arrive token by token instead of in one lump. Nothing else about the system may
depend on it existing. Every question a client can answer from a live socket — is a turn
running, did it finish, what did it produce, is a research run waiting on me — it must also
be able to answer by asking the server over HTTP, because sooner or later the socket is
gone at exactly the moment the answer matters.

That premise generates the rest.

## Rules

### 1. The server finishes the work whether or not anyone is listening

`ws/sendMessage.ts` wraps every `postToConnection` in `safePost`, which swallows the
`GoneException` (HTTP 410) a dead connection returns and sets `connectionGone`. The stream
loop runs to completion regardless. A client disconnecting is not an error condition and
must never abort work the user already paid for.

The bug this prevents is subtle and was real: without the swallow, the first 410 propagated
as an error, the error path called `postFn` again, that threw uncaught, and the Lambda
crashed — losing the turn *because* the user backgrounded the tab.

### 2. Persist progress incrementally, never only at the end

Each round of the agentic loop is written to DynamoDB as it completes and `activeLeafId`
advances with it. So a client that missed the frames can still see everything up to the
last completed round. If work is only persisted at the end of a long operation, a
disconnect turns "you missed the narration" into "you lost the result".

### 3. Catch-up is a refetch, not a re-attach

Frames are addressed to one connection id. A new socket cannot be joined to a stream
already in progress, and buffering frames server-side for an absent client is a queue with
no owner and no expiry. So reconnection recovers *state*, not *frames*: `GET /messages`
returns what has been persisted, and the UI reconciles to it.

The honest cost is that catch-up advances in poll-sized steps rather than streaming — a
long tool-using turn updates every 3 seconds instead of per token. That is the correct
trade; pretending otherwise is what produces re-attach schemes that never quite work.

### 4. Anything a client only learns from a frame is a thing it can permanently miss

This is the rule that keeps generating bugs, because a push-only path looks complete right
up until the push fails.

- "A turn is running" existed only as a live stream → the chat row now carries
  `streamingSince`, exposed as `streaming` on `GET /messages`, and the client polls it.
- "Your research run finished" existed only as a `research_done` frame → the `RUN#` row is
  the source of truth and refocus re-reads it.
- **Still open:** research plan approval travels only over the WebSocket (`researchApprove`).
  A run parked at `AwaitApproval` with a dead socket cannot be approved, even though its
  Step Functions task token is valid indefinitely. This wants an HTTP route.

The test for a new frame type: if this frame is dropped, can the client ever find out what
it said? If the only answer is "the user reloads and hopes", there is a missing pull path.

### 5. A liveness marker written by a process that can be killed needs an expiry

`streamingSince` is cleared on every exit `ws/sendMessage.ts` can reach — errored,
cancelled, normal — but a Lambda killed at its 600 s ceiling clears nothing. So readers
treat a marker older than 11 minutes as debris (`STREAM_STALE_MS` in `http/messages.ts`)
rather than a live turn. Without that, one killed Lambda leaves a chat polling forever.

Any flag meaning "something is happening right now" needs a defined answer to "what if the
writer dies between setting and clearing it".

### 6. Credentials in a connection URL must be read at connect time, not cached

`$connect` authorises from a `?token=` query param, because browsers cannot set headers on
a WebSocket handshake. `ws.ts` captured that token once at first connect and reused it on
every reconnect. Cognito access tokens live 60 minutes.

A phone asleep across the expiry woke up retrying a dead token forever — 461 identical
`ws_auth_failed / Token expired` authorizer log lines over two hours, behind a spinner. The
fix is a token *provider* called per connect (`docs/adr/0036`), never a token value.

Corollary: **do not rely on a renewal timer.** `oidc-client-ts` renews on
`accessTokenExpiring`, 60 seconds before expiry. A frozen tab does not run timers, so that
event simply never fires for the case that needs it most. Renew on demand — when a
connection is actually about to be made — and on resume.

### 7. A retry loop must terminate in something the user can act on

A spinner promises "this will succeed shortly". When the retry can never succeed, the
spinner is a lie the user cannot escape without knowing to hard-reload. Reconnects are
capped (5 attempts, ~30 s) and then enter a distinct `'unauthorized'` state that renders a
**Reconnect** button.

ADR 0021 explicitly accepted an unbounded loop, reasoning that "the user eventually gives
up and reloads". That reasoning was the bug. Retry forever is only acceptable when the
retry is free *and* the condition is genuinely transient; neither held.

### 8. Count failures, don't classify them

A WebSocket upgrade rejected by the authorizer is indistinguishable in the browser from a
network failure — no status code reaches JavaScript, just `onclose`. So the client cannot
branch on "auth problem" vs "offline". It counts consecutive failures and, past the cap,
offers the one action that fixes both (reconnect with a fresh token).

Design retry logic around what the client can actually observe, not around the taxonomy of
failures you know exists on the server.

### 9. A refetch must not clobber a live stream

The refocus handler captures `isConnected()` *before* calling `ensureConnected()`. A socket
that is genuinely still open means the backend stream is live — force-reloading there would
paint only the rounds persisted so far and then race the frames still arriving for the
current round, rendering as two stacked bubbles.

Recovery paths need the same care as the happy path: "reload everything on resume" is a
race, not a fix.

### 10. Optimistic UI needs a reconciliation path for every flag it sets

A `sending` flag pinned true by an operation that can silently never complete is how a UI
becomes permanently stuck. Chatrock has three separate recoveries because they are three
different failures:

- **`armAckWatchdog`** — the send never landed (no `ack` within 12 s): discard the
  optimistic bubble, ask the user to resend.
- **Refocus catch-up** — the send landed and finished while we were away: reconcile to the
  server's state.
- **Streaming poll** — the send landed and is *still running* on a connection we lost:
  poll until it completes.

Also: the composer draft is persisted to `localStorage` until the send is confirmed
delivered, so a resume that discards an optimistic bubble does not discard what the user
typed.

### 11. Write markers without side effects on unrelated state

`setChatStreaming` deliberately does not touch `updatedAt` — that attribute orders the
sidebar, and a chat that jumped to the top every time a poll marker was written would be a
visible bug produced by an invisible mechanism.

## What mobile browsers actually do

- **iOS closes the WebSocket when the tab backgrounds.** Not "may" — assume every
  background is a disconnect.
- **A resumed tab can hold a socket that reports `OPEN` but is dead.** No `close` event
  fires until a send fails. Do not treat `readyState` as proof of liveness for anything
  important.
- **Timers do not run while frozen.** Anything scheduled — token renewal, heartbeats,
  watchdogs — silently does not happen. Event-driven (`visibilitychange`, `focus`,
  on-demand) beats scheduled.
- **`visibilitychange` and `focus` both fire on resume,** often together, and a reconnect
  can land on top of them. Dedupe work triggered from resume — the token renewal shares one
  in-flight promise for exactly this reason.
- **The device may resume on a different network,** hours later, with a different IP.
  Nothing about the old connection is reusable.

## Checklist for a new real-time feature

1. Does the server complete its work if the client vanishes at any point?
2. Is progress persisted incrementally, so a partial result survives?
3. Is there an HTTP route that answers every question the frames answer?
4. Does any state flag have an expiry, in case its writer is killed?
5. Are credentials read at use time rather than captured?
6. Does every retry loop end in a user-actionable state?
7. Does every optimistic UI flag have a path back to false that does not require the
   operation to succeed?
8. Has it been tested by actually backgrounding a phone mid-operation for an hour? Nothing
   in this list was found by unit tests.

The last one matters most. Every rule above came from a production incident, not a test
suite — the failure mode is a device doing nothing for a long time, which is precisely what
no automated test does.
