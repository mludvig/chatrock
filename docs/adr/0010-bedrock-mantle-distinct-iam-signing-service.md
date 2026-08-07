# 10. Bedrock Mantle requires its own, empirically-derived IAM signing service

## Status

Accepted

## Context

Adding OpenAI GPT-5.6 support meant calling Bedrock Mantle's Responses API (`backend/src/lib/llm/providers/bedrockMantle.ts`). By analogy with the existing Anthropic-via-Converse IAM statement, the assumption was that permissions would be `bedrock:InvokeModel*` against a foundation-model/inference-profile ARN — the same shape Converse uses. Deploying against that assumption produced a real `AccessDeniedException`. AWS does not publish a documented IAM reference for Mantle's actual signing-service/action/resource shape (confirmed as of August 2026).

## Decision

Empirically derive the real shape from the `AccessDeniedException` and hardcode it (`terraform/iam.tf`'s `InvokeBedrockMantle` statement): Mantle signs as a **distinct service**, `bedrock-mantle` (not `bedrock`), with a single action `bedrock-mantle:CreateInference`, scoped to a **fixed per-account** `arn:aws:bedrock-mantle:us-east-1:<account>:project/default` — a "default project" ARN, not a per-model resource like Converse's foundation-model ARNs. The region is hardcoded to `us-east-1` in the statement itself since Mantle models are pinned there regardless of `var.aws_region` (no cross-region inference profile exists for Mantle as of Aug 2026).

## Consequences

- This IAM statement will silently go stale if AWS ever changes Mantle's signing shape or introduces per-model resource scoping — there's no way to detect that in advance without hitting another undocumented `AccessDeniedException`.
- Adding a second Mantle-served region later requires widening this ARN's region manually, not just adding a `config/models.ts` entry — easy to miss, since every other provider's region handling is more flexible (`region` is per-model capability metadata elsewhere).
- Worth periodically re-verifying against AWS's docs/changelog, since "confirmed empirically against a real deploy, not documented" is an inherently fragile source of truth for an IAM policy.
