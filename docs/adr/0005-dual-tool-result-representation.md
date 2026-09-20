# 5. Dual live/persist representation for tool results

## Status

Accepted

## Context

A tool-use round's results — especially image-bearing ones like browser screenshots — need to serve two different purposes at once: (a) get replayed back to the model in the very next round of the same agentic-loop invocation, where the Converse/Responses APIs need inline image bytes; (b) get durably persisted to DynamoDB, where a multi-MB image blob would blow the 400KB item size limit and bloat every future read of that chat.

Alternatives considered:

1. **Always store inline bytes.** Simplest, but breaks at DynamoDB's 400KB item cap for any chat with more than a couple of screenshots.
2. **Always store S3 locations, re-hydrate from S3 before every replay.** Adds an S3 round-trip on every tool round of a multi-round agentic loop, for image bytes the loop already has sitting in memory from the tool call that just ran.
3. **Build both representations once per round, from the same tool result.** `toolResultsLive` (image bytes inline, kept only in this invocation's in-memory `newMessages` for the rest of the loop, never persisted) and `toolResultsPersist` (S3 `s3Location`/`s3Uri` references, written to DynamoDB and to the yielded `turn` chunk).

## Decision

Option 3, built in `backend/src/lib/llm/loop.ts`'s tool-execution loop. Text-only tool results are identical in both representations (nothing to differ on) and unaffected by the split; only image-bearing results diverge.

## Consequences

- No extra S3 round-trip within a single invocation's agentic loop — image bytes already in memory are reused directly for the next round's model call.
- DynamoDB items stay small regardless of how many or how large the images generated during a turn were.
- The two arrays must stay in lockstep — same length, same `toolUseId`/`callId` order — or live replay and persisted history desync. `perCallCap`'s per-tool text-truncation budget is computed once per round (from `toolUses.length`) before either array is built, so both representations get identical truncation.
- On a fresh Lambda invocation (e.g. reloading the chat later), only the S3-referenced form exists to rehydrate from (`hydrateBlocks`) — the inline-bytes optimization applies solely within one invocation's lifetime, never across reloads.
