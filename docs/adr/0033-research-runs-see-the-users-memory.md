# 0033 — Research runs see the user's memory, through the planner

## Status

Accepted.

## Context

A Deep Research run was assembled entirely from the raw question: the Step Functions input
carried only `{chatId, runId, sub, question, connId}`, and no handler read user memory,
project memory or project instructions. Runs therefore spent their clarifying questions
re-asking things the user had already told Chatrock — "which country do you mean?" — and,
when the user answered, the answer only reached the plan, never the researchers.

## Decision

`ws/startResearch.ts` snapshots a compact context block — the user's memories, plus the
project's instructions and memories when the chat belongs to a project — onto the `RUN#`
row as `context` (capped at 4000 characters). `research/context.ts` builds it and reads it
back; `plan.ts` prepends it to the Plan and Replan prompts as an `ABOUT THE USER` block.

Only the planner sees it. `prompts/research-plan.txt` tells the planner to resolve
ambiguity from the block instead of asking about it, and to write the relevant specifics
into the sub-question text itself, since each researcher sees only its own sub-question.

## Consequences

- A run stops asking what memory already answers, and country/jurisdiction-specific detail
  reaches the researchers as part of the sub-question they were given.
- Snapshotted at start rather than re-read per phase, for the reason ADR 0030 gives for the
  model: `AwaitApproval` and `Assess` have no `ResultPath`, so a threaded field would be
  dropped, and a run should not shift under the user mid-flight if they edit a memory.
- Only the plan prompt grows; researcher and report prompts are unchanged. Rejected:
  injecting the block into every stage — it would repeat the same tokens across every
  parallel researcher, and a researcher that knows about the user is a researcher that can
  drift off its assigned sub-question. If a plan ever proves too lossy a channel, the block
  is already on the row for `researcher.ts` to read.
- Rejected: including prior chat turns. A research question is asked as a self-contained
  question, and the transcript is unbounded where memory is already distilled.
- The run writes nothing back — no `manage_memory` tool is offered anywhere in a run.
