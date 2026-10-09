# 0057. Stall timeout and a heartbeat while waiting on the model

## Status

Accepted

## Context

A provider request can go silent: a GPT-6.1 Sol round at max effort sent nothing for 300s until undici's body timeout killed it with `TypeError: terminated`, after which the round retry (ADR 0041) succeeded in seconds. For those five minutes the client showed a bare "Processing…" with no way to tell a live turn from a dead one. Normal rounds produce their first event within about 15s, even at max effort.

## Decision

`loop.ts` runs every provider round through `watchedTurn`. While the provider is silent it yields the existing `heartbeat` chunk every 4s, which `sendMessage.ts` already forwards. After 90s with no event at all it aborts that request through its own `AbortController`, chained to the turn's so a user Stop still reaches it. It then throws a `stream stalled` error, which counts as transient, so the ADR 0041 retry takes over. On the client, a heartbeat that arrives when no visible content has come in for 45s shows a notice under "Processing…": the turn is taking longer than usual, and the user can leave and come back for the saved answer (ADR 0037 catch-up).

## Consequences

A dead request costs 90s instead of 300s. A stall after some output has already streamed still fails the turn rather than retrying, as in ADR 0041. A model that genuinely needs more than 90s of total silence would be cut off; none observed comes close.

Alternatives rejected:

- **Shortening the SDK/undici socket timeouts.** The timeout would differ per provider client, and it can't drive heartbeats.
- **A client-only timer for the notice.** Without server heartbeats the client can't tell "still working" from "dead", which is the whole point of the notice.
