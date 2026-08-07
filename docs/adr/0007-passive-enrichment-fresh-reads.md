# 7. Passive memory enrichment re-reads state fresh, after the agentic loop

## Status

Accepted

## Context

Two things can write to the same user/project memory store for a single turn: the model calling `manage_memory` explicitly mid-loop, and passive enrichment (`enrichUserFacts`/`enrichProjectFacts`, an automatic post-turn Sonnet call in `lib/enrichment.ts`) run unconditionally afterward. Both need to reconcile against "what memories currently exist" to decide whether to add, update, or leave things alone.

Alternatives considered:

1. **Reuse the pre-loop snapshot.** The system prompt already has a snapshot of existing memories assembled before the agentic loop starts (`promptAssembly.ts`). Reusing it for enrichment's reconciliation base is free — no extra DynamoDB read — but blind to anything the model itself wrote via `manage_memory` during that same turn, producing duplicate or conflicting entries.
2. **Re-read `existing` memories fresh from DynamoDB after the agentic loop completes**, so enrichment reconciles against current truth — including any mid-loop `manage_memory` writes — rather than re-deriving facts the model already recorded.

## Decision

Option 2, in `ws/sendMessage.ts`'s post-turn enrichment block.

## Consequences

- One extra DynamoDB read per turn when `memoryEnabled` — negligible cost for the correctness gained.
- Enrichment and `manage_memory` can never race into duplicate entries for a fact established during the same turn.
- This ordering is load-bearing and not obvious from reading `enrichUserFacts`/`enrichProjectFacts` in isolation — an innocuous-looking refactor to "just reuse the snapshot we already built for the prompt" would silently reintroduce duplicate memories. Documented in `backend/CLAUDE.md`'s Memory section as well as here.
