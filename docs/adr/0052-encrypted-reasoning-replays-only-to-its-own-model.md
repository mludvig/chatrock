# 0052. Encrypted reasoning replays only to the model that produced it

## Status

Accepted

## Context

Responses API calls send back each earlier reasoning item with its `encrypted_content` (`store:false`, ADR 0048). On Bedrock that payload decrypts only for the model that produced it, and each model's payload carries a fixed per-model prefix. When a chat moved between GPT models (by hand, or automatically under ADR 0050's retirements), the next send failed with `400 encrypted reasoning was created for a different model`, `400 Encrypted content cannot be used in a different region…`, or a 500, and kept failing. Measured Sep 2026: same-model replay always worked, and cross-model replay failed for every pair except one. GPT-5.6+ does use earlier-turn reasoning (OpenAI's reasoning guide; `input_tokens` rises by its size), so it is worth keeping for the model that made it.

## Decision

The reasoning opaque records the model that produced it (`responsesTranslate.toNeutral`). `fromNeutralMessages` replays a reasoning item only to that same model and drops it for any other, the same way Claude thinking is dropped for GPT. Reasoning stored without a model is dropped too. `bedrockResponses.streamTurn` also retries once without any reasoning if a call still fails with either 400 above, as a safety net for these undocumented rules.

## Consequences

- Switching GPT models loses the old model's reasoning continuity. The visible answers and tool calls still carry over.
- GPT chats stored before this change lose earlier-turn reasoning once.
- Rejected alternatives:
  - Retry-on-error only: costs a failed call on every send, and the 500 case can't be told apart from real errors.
  - Always dropping earlier-turn reasoning: loses context GPT-5.6+ uses.
  - Replaying the reasoning `id` without `encrypted_content`: with `store:false` there is nothing server-side for the id to refer to.
