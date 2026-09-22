# 0051 — Kimi K3 on the Responses API

## Status

Accepted (2026-09-23).

## Context

Bedrock serves Moonshot's Kimi K3 (`global.moonshotai.kimi-k3`) on both Converse and the OpenAI-compatible Responses API on bedrock-runtime. We tested both from ap-southeast-2.

On Converse, Kimi rejects `temperature`, `topP`, document blocks and `cachePoint`, and it always reasons: no effort parameter changes its output. On Responses, it accepts PDF `input_file`, caches prompts (the second identical call read the whole prefix from cache), and honours `reasoning.effort` from `none` to `max`. Images, tools and forced tool choice work on both.

## Decision

Kimi K3 uses the existing `bedrock-responses` provider (`lib/llm/providers/bedrockResponses.ts`) with `thinking: 'effort'` and all five effort levels.

Three small generalisations cover how Kimi differs from GPT:
- `response.reasoning_text.delta` streams as thinking, just like GPT's reasoning-summary deltas.
- A reasoning item with an empty `summary` takes its text from its `reasoning_text` content.
- `off` is sent as `effort: 'none'`. Kimi K3 lists all five levels, so it's the model that can switch reasoning off (`docs/adr/0053-thinking-levels-as-model-data.md`).

## Consequences

Kimi chats get documents, caching and an effort dial with no new provider. Kimi returns no `encrypted_content`, so replay sends its reasoning text as the item's summary; Kimi accepts that across tool rounds. The same IAM statement as GPT already authorizes it.

Rejected: Converse. It would mean no documents, no caching and no way to control reasoning.
