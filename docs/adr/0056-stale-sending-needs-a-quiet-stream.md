# 0056. A sending flag is only stale once the stream has gone quiet

## Status

Accepted

## Context

`reloadMessages` self-heals a `sendingByChat` flag left stuck by a missed `done`/`cancelled`/`error` frame: when `GET /messages` reports `streaming: false`, it paints the server's messages and clears the stream. It used "the ack watchdog has been cleared" as proof the turn had started server-side. But `ws/sendMessage.ts` sends `ack` before it persists the user turn and the streaming marker, so a fetch landing just after the ack could read "no messages, not streaming" for a live turn. The first question of a new chat then vanished until `done`, and Stop disappeared mid-stream.

## Decision

The client stamps a per-chat last-frame time on send and on every WS frame. The self-heal treats `sending` as stale only when `streaming: false` *and* no frame has arrived for that chat in the last 15s, which is longer than both the 4s tool-call heartbeat and the 12s ack watchdog.

## Consequences

A genuinely stuck flag now heals up to 15s later than before, which is harmless for a state that was otherwise stuck indefinitely. Alternatives rejected: sending `ack` after the marker is written doesn't cover a fetch issued before the ack but answered after it, and would also need strongly consistent reads on the messages handler. Comparing request-issue time with ack arrival has the same gap, since the ack still comes before the writes.
