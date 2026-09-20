# 0041 — Retrying a provider round that produced no output

## Status

Accepted.

## Context

Provider streams drop. A GPT-6 Astra turn on a 123k-token input died 46s in with undici's
`TypeError: terminated` — the SSE socket closed mid-response, after a completed first round
(a `manage_memory` tool call) and before the second round had shown the user anything.
Nothing was wrong with the request; re-issuing it would have worked. Instead the turn ended
in an error bubble carrying a stack-trace-shaped string the user can do nothing with.

A blanket retry is not available: once deltas or thinking text have been forwarded to the
client, re-running the round replays them, and the user watches the answer start twice.

## Decision

`loop.ts`'s `streamRounds` retries a round **only while it has forwarded zero chunks** — up
to `ROUND_RETRIES` (2) attempts, 500ms then 1500ms backoff, and only for transient errors
(dropped sockets, `ECONNRESET`/`EPIPE`/`ETIMEDOUT`, throttles, 408/429/5xx). An aborted
signal, a 4xx, or any already-forwarded output propagates the error as before. Each retry
logs `llm_round_retry`.

Retry lives in the provider-agnostic loop, not in an adapter: the round's inputs
(`builtMessages`, `turnIndex`, `cacheBoundaryIndex`) are untouched until the round
completes, so a second `provider.streamTurn` with the same request is a clean do-over — and
Converse gets the same protection as the Responses provider for free.

A drop that survives the retries (or happened mid-output) is reported to the user as "The
connection to the model dropped mid-answer — press Continue to resume." (`ws/sendMessage.ts`),
with the raw error kept in the `stream_error` log record. Partial text was already flushed
as an `incomplete` turn, so Continue genuinely resumes.

## Consequences

- Transient drops before first output become invisible, at the cost of up to 2s of added
  latency on a genuinely failing call.
- A drop **after** first output still surfaces as an error — deliberately. Resuming that
  case is Continue's job, not a silent retry's.
- Rejected: retrying inside `bedrockResponses.ts` only (misses Converse, and the adapter can't
  see whether the loop already forwarded anything); retrying unconditionally with client-side
  de-duplication of replayed text (the client would have to diff two partial streams — far
  more machinery than the failure mode warrants); relying on the OpenAI SDK's own
  `maxRetries` (it covers connection setup, not a mid-body socket close).
