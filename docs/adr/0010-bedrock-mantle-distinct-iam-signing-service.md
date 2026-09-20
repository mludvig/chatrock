# 10. Bedrock Mantle requires its own, empirically-derived IAM signing service

## Status

Superseded by [0048](0048-openai-models-on-bedrock-runtime.md)

## Context

Adding OpenAI GPT-5.6 support meant calling Bedrock Mantle's Responses API (`backend/src/lib/llm/providers/bedrockMantle.ts`). By analogy with the existing Anthropic-via-Converse IAM statement, the assumption was that permissions would be `bedrock:InvokeModel*` against a foundation-model/inference-profile ARN — the same shape Converse uses. Deploying against that assumption produced a real `AccessDeniedException`. AWS does not publish a documented IAM reference for Mantle's actual signing-service/action/resource shape (confirmed as of August 2026).

## Decision

Empirically derive the real shape from the `AccessDeniedException` and hardcode it (`terraform/iam.tf`'s `InvokeBedrockMantle` statement): Mantle signs as a **distinct service**, `bedrock-mantle` (not `bedrock`), with a single action `bedrock-mantle:CreateInference`, scoped to a **fixed per-account** `arn:aws:bedrock-mantle:*:<account>:project/default` — a "default project" ARN, not a per-model resource like Converse's foundation-model ARNs. The region segment is wildcarded (not derived from `var.aws_region`) since Mantle models can be pinned to any region independent of the backend's own region (see `config/models.ts`'s per-model `region`), and the resource is a fixed per-account "default project" either way — there's no narrower scoping IAM could offer here.

## Consequences

- This IAM statement will silently go stale if AWS ever changes Mantle's signing shape or introduces per-model resource scoping — there's no way to detect that in advance without hitting another undocumented `AccessDeniedException`.
- The region wildcard was adopted after an initial region-hardcoded version broke: pinning GPT-6 Astra to `us-west-2` in `config/models.ts` left the IAM statement scoped only to `us-east-1`, producing an `AccessDeniedException` on first deploy against the new region.
- Worth periodically re-verifying against AWS's docs/changelog, since "confirmed empirically against a real deploy, not documented" is an inherently fragile source of truth for an IAM policy.
