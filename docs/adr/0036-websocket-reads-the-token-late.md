# 0036. The WebSocket reads its access token at connect time, not at startup

## Status

Accepted.

## Context

`$connect` authorizes from a `?token=` query param, so every socket carries an access token in its URL. `api/ws.ts` captured that token once at first connect and reused it for every reconnect. Cognito access tokens live 60 minutes; `oidc-client-ts` only renews on its `accessTokenExpiring` event, which fires 60 seconds before expiry — a phone that sleeps through that window wakes holding a dead token and nothing re-triggers a renewal. A chat with a turn or research run in flight reconnects on every close, so the client retried the same expired token indefinitely: observed in production as two hours of identical `ws_auth_failed / Token expired` authorizer logs behind a permanent "Connection lost, reconnecting…" spinner.

## Decision

`ws.ts` holds a `TokenProvider` (`() => Promise<string>`) instead of a token, and calls it on every connect and reconnect. `App.tsx` supplies a provider that returns the current token when it has more than 120 seconds left and otherwise awaits `signinSilent()`, deduped through a shared in-flight promise, and also runs on `visibilitychange`/`focus`. Reconnects are capped at 5 attempts, after which the connection state becomes `unauthorized` and the UI offers a Reconnect button.

## Consequences

Renewal happens when a connection is actually needed rather than on a timer the browser may never fire, so a resumed tab reconnects with a valid token. The cap means a genuinely unreachable backend stops retrying after roughly 30 seconds and asks the user, rather than spinning forever; `reconnectNow()` resets it.

Alternatives rejected: relying on `automaticSilentRenew` alone — it is exactly the timer a sleeping tab misses; classifying handshake failures as auth vs. network — the browser exposes no status code for a failed WebSocket upgrade, so failures can only be counted, not distinguished; passing the token into `connect()` from each call site — the reconnect path has no call site, which is how the bug arose.
