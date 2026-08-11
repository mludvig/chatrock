# 19. Prompt cache breakpoint placement

## Status

Accepted

## Context

Bedrock Converse prompt caching works via explicit `cachePoint` markers, each caching the exact prefix up to that point — an exact-byte-match hit, or a full-price miss and rewrite if anything in that prefix changed. `bedrockConverse.ts` places three independent markers per request: one trailing the tool list, one trailing the system prompt, one at `cacheBoundaryIndex` in the message history (the last message stable for the rest of this round). Each breakpoint hits or misses independently of the others.

The system prompt is assembled fresh every turn (`assembleSystemPrompt`, called once per WS invocation) from instructions, resolved prefs, user memory, project memory, and the project manifest, re-read from DynamoDB each time — see "Memory: passive enrichment" and `docs/adr/0007-passive-enrichment-fresh-reads.md`. It is emitted as a single string with one `cachePoint` at the end.

## Decision

Keep the system prompt as one string with a single trailing cache marker, rather than splitting it into a stable prefix (base instructions) and a volatile suffix (memory/manifest) with two markers.

## Consequences

- Any change to user memory, project memory, or the project manifest between two turns (a manual edit, or the model's own `manage_memory`/`manage_project_memory` call from a prior turn) invalidates the *entire* system-prompt cache block on the next turn — it's rewritten at full price, even though most of the prompt text (base instructions) didn't change.
- The tool-list and conversation-history breakpoints are unaffected by memory churn — they're separate markers and keep hitting normally.
- Simpler than a two-breakpoint split, and correct today: memory doesn't change every turn, so most turns still get a system-prompt cache hit. Worth revisiting (stable-prefix + volatile-suffix, two cache points) if memory-heavy projects start showing this cost in `llm_call` usage logs.
