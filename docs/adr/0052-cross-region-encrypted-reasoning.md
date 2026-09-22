# 0052. Retry without reasoning when encrypted reasoning is from another region

## Status

Accepted

## Context

Responses API calls replay each earlier reasoning item with its `encrypted_content` (`store:false`, ADR 0048). That payload only decrypts in the AWS region that produced it, and a `global.*` inference profile routes each call to any region. So any GPT chat can fail at random with `400 Encrypted content cannot be used in a different region from the one that created it`, and every later send in that chat can fail the same way. GPT-5.6+ renders earlier-turn reasoning into the next sample by default (OpenAI's reasoning guide; confirmed on Bedrock by `input_tokens` rising by the reasoning's size), so dropping it on every call would cost answer quality.

## Decision

Replay reasoning as before. If a call fails with exactly that 400, `bedrockResponses.streamTurn` retries it once with every reasoning item removed. That history shape is the one a chat switched from Claude already sends. The error arrives before any streaming, so nothing is emitted twice.

## Consequences

- A chat whose stored reasoning came from another region pays one fast rejected call before each successful one, and that call runs without its earlier reasoning.
- Rejected alternatives:
  - Always dropping reasoning from earlier turns: loses context the model uses.
  - Pinning a regional (non-global) profile: gives up the global profile's capacity.
  - Replaying the reasoning `id` without `encrypted_content`: `store:false` keeps nothing server-side for the id to refer to.
