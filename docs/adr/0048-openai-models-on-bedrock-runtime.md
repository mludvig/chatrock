# 48. OpenAI models on bedrock-runtime's Responses API

## Status

Accepted. Supersedes [0010](0010-bedrock-mantle-distinct-iam-signing-service.md).

## Context

Bedrock serves OpenAI GPT models on two endpoints: `bedrock-mantle` (in-region only, a separate `bedrock-mantle` IAM service, GPT-5.6 in us-east-1/2 and GPT-6 Astra only in us-west-2) and `bedrock-runtime`, which exposes the same OpenAI Responses API at `/openai/v1` behind `global.openai.*` cross-region inference profiles and ordinary `bedrock:InvokeModel*` IAM. Mantle meant per-model region pins, a per-region client map, and an IAM shape we had to derive from an `AccessDeniedException`. Its extras (server-side tools, background mode, projects) are features chatrock doesn't use.

## Decision

The `bedrock-responses` provider (`lib/llm/providers/bedrockResponses.ts`) calls the Responses API on bedrock-runtime from the backend's own region, via `openai` ≥ 7.20's `bedrock({ endpoint: 'runtime' })` provider (SigV4 as `bedrock`, bearer-token fallback unchanged). Models are `global.openai.gpt-5.6-{sol,terra,luna}` and `global.openai.gpt-6-astra`. IAM adds `arn:aws:bedrock:<region>:<account>:project/default` to the existing InvokeModel statement.

We verified this with a spike from ap-southeast-2 before building it. All four models stream with a first token in about 1s. Encrypted reasoning round-trips, including reasoning produced on Mantle. Tool round-trips work, including forced `tool_choice` with reasoning on. Automatic prompt caching reads back the full prefix on later calls. Image and PDF `input_file` inputs are accepted. Abort ends the stream cleanly.

## Consequences

- There are no region pins, and the Lambda role authorizes the GPT models with the same IAM statement as the Anthropic models.
- We keep the `openai` SDK for a single provider. The AWS JS SDK has no Responses API command, and a hand-rolled SigV4 + SSE client would duplicate the SDK's typed stream parsing.
- Chats that still reference the old `openai.gpt-*` IDs self-heal to `DEFAULT_CHAT_MODEL` on their next read (`lib/chatDto.ts`); we keep no alias table.
- Reasoning blocks stored under the old `bedrock-mantle` opaque tag are dropped on replay as foreign thinking. This costs only reasoning continuity on pre-existing GPT turns.
- Rejected alternatives:
  - Converse for GPT: GPT rejects document blocks and explicit `cachePoint` there.
  - Staying on Mantle: it keeps the region pins and the undocumented IAM shape.
