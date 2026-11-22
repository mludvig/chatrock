# 0069: Output-limit notice and explicit continuation

## Status

Accepted.

## Context

A provider can stop with `max_tokens` after spending the output budget entirely
on thinking. The WebSocket reports this reason, but persisted responses did not
retain it. Users saw a stopped response without an explanation or a Continue
action, including after reloading or returning from a disconnected session.

## Decision

Persist the provider stop reason on assistant turns and expose the latest
assistant turn's reason on each response bubble. For `max_tokens`, display an
output-limit notice and a labeled Continue button using the existing continuation
path. Distinguish responses with answer text from thinking-only responses.
A later continuation replaces the earlier stop reason, so a completed response
does not retain a stale output-limit notice.

Keep output budgets unchanged. Continuation requires an explicit user action.
Research-round limits retain their existing separate behavior.

The continuation request ends with a transient user instruction to complete the
answer without repetition. It preserves the original assistant leaf and response
group, without adding a visible user bubble. Assistant prefill was rejected:
a live API probe confirmed that Opus rejects assistant-terminated requests.

## Consequences

The notice survives refetch, reload, and socket loss without depending on a live
event. Existing records without a stop reason remain unchanged; no token-count
heuristic or migration guesses why historical responses stopped.

Automatic continuation was rejected because it starts another paid response
without a new user action. A WebSocket-only notice was rejected because it would
be lost on reload or disconnect. Increasing token budgets is a separate change,
so this behavior can first be verified at the existing limits.
