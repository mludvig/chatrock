# 0030 — A Deep Research run uses the chat's model at every stage

## Status

Superseded by `0039-deep-research-as-a-sub-agent-tool.md`.

## Context

Every LLM call in a Deep Research run — plan, each parallel researcher, assess, report —
was hardcoded to `DEFAULT_CHAT_MODEL`, so the model the user picked in the composer before
starting the run had no effect on any of it. The obvious alternative is a derived tier
(a cheap model for the many researcher calls, the chat's model only for plan/report), but
that trades quality for cost on the stage that does the actual investigating, with no data
yet on whether the cost is a problem.

## Decision

The chat's model is snapshotted onto the `RUN#` row (`model`) when `ws/startResearch.ts`
starts the execution, and every phase handler reads it back via `research/model.ts`'s
`resolveRunModel()` and uses it for its own call — no per-stage tier. `report.ts` also
stamps it on the assistant turn it persists, so the transcript records what actually
generated the report.

Read back from the row rather than threaded through the Step Functions state alongside
`connId`: `AwaitApproval`'s `SendTaskSuccess` and `Assess`'s return value each replace the
*entire* state, so a threaded field has to be re-emitted correctly at three separate call
sites (plus four ASL `Parameters` blocks) or it silently vanishes mid-run. One `GetItem`
per phase buys immunity from that whole class of bug. Snapshotting rather than re-reading
`chat.model` keeps a run coherent if the user switches the chat's model while it is in
flight; an unknown or retired model id falls back to `DEFAULT_CHAT_MODEL`, the same
self-healing `http/chats.ts`'s `resolveChatModel()` applies.

## Consequences

Picking Opus for a research run now costs Opus prices across every researcher in every
wave — accepted deliberately for now, to be reassessed once real token numbers exist (the
`llm_call` records carry `purpose: research_worker` and `runId`, so the split is already
measurable). Runs started before this change have no `model` on their row and keep running
on `DEFAULT_CHAT_MODEL`. Each phase pays one extra DynamoDB `GetItem`; the researcher pays
it once per sub-question.
