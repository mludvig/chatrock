# 0027 — Deep Research progress as ephemeral step-boundary frames

## Status

Accepted.

## Context

A Deep Research run went minutes at a time with nothing on screen between its status
changes: recon, each researcher's searches, the supervisor's assessment, the report, and
the dossier write were all invisible until the frame that ended the phase. A normal chat
turn shows thinking blocks and tool pills as they happen, and the run needed the same.

The obvious approach — forward `converseStream`'s chunks the way `ws/sendMessage.ts` does
— does not fit here. A wave runs up to three researchers as separate concurrent Lambda
invocations pushing to one WebSocket connection, so token-level deltas would need
per-source reassembly on the client, and each token would be its own `postToConnection`
call. A researcher's answer text also already arrives whole as its `research_finding`, so
streaming its deltas would render the same prose twice.

## Decision

Two best-effort frames, emitted at step boundaries by `backend/src/research/progress.ts`:

- `research_step` carries one complete thinking block or tool call, keyed by
  `toolUseId` and tagged with its `subQuestionId`. Emitted only where a real
  `converseStream` loop exists (each researcher) or a real tool call does (recon).
- `research_phase` carries a coarse "what is the run doing now" signal for the phases
  that make a single blocking `converseOnce` call (plan, assess, report) plus the dossier
  write, which yield no chunks at all.

Steps are never persisted to the `RUN#` row and are not returned by
`GET /api/chats/{chatId}/research`.

## Consequences

Concurrent researchers need no coordination: every frame is self-contained and keyed, so
a dropped one costs a single missing pill rather than a corrupted stream, and the client
upserts tool steps by `toolUseId` instead of merging partials. `progress.ts`'s
`stepEmitter` is the one place `StreamChunk`s are translated, so handlers don't each grow
their own copy of that mapping. The frontend renders the frames through
`StepBlocks.tsx` — the same `ThinkingBlock`/`ToolCallPill` a normal turn uses, extracted
out of `MessageBubble.tsx` for that purpose — so research progress cannot drift visually
from ordinary tool use.

Rejected — **token-level forwarding**: for the reasons in Context; it buys nothing a
researcher's `research_finding` doesn't already deliver.

Rejected — **persisting steps on the `RUN#` row**: it would mean a DynamoDB write per tool
call from three concurrent Lambdas onto one item (write contention, growth toward the
400 KB cap) purely to cosmetically replay pills the user already missed. Reconnect
continues to re-sync phase and findings, which is the state that matters, and this keeps
the documented "frames are best-effort, the `RUN#` row is the source of truth" design
intact.

Rejected — **one frame type for everything**: forcing a single blocking `converseOnce`
call to masquerade as a "step" would misreport what the run is actually doing.

The cost accepted is that a client which reconnects mid-run sees no steps until the next
frame arrives — progress resumes rather than replays.
