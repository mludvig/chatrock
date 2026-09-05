# 0039 — Deep Research as a sub-agent tool

## Status

Accepted. Supersedes `0023-deep-research-step-functions-orchestration.md`,
`0025-researcher-finding-plain-text-summary.md`,
`0027-research-progress-as-step-boundary-frames.md`,
`0030-research-runs-use-the-chats-model.md`, `0031-deep-research-is-not-a-project.md`,
`0032-plan-feedback-classified-by-a-tiny-model.md`,
`0033-research-runs-see-the-users-memory.md`,
`0034-research-runs-carry-the-questions-attachments.md`,
`0035-a-failed-research-run-is-a-terminal-state.md`, and
`0038-research-runs-see-project-files.md`.

## Context

The Step-Functions-orchestrated Deep Research system (`0023`) was a durable multi-agent
state machine running alongside the chat: its own `RUN#` DynamoDB rows, its own plan/
approve/steer WS actions, its own Lambdas per stage (recon, plan, researcher waves,
assess, report), reconciled back into the chat asynchronously. That durability was the
point — a run could outlive the WebSocket, resume after a phone backgrounded, and survive
a Lambda timeout on any one stage.

It also caused a live production bug: two runs for different chats could read/write the
same `activeResearch` state, bleeding one chat's plan/findings into another's view. The
root cause was structural, not a one-line fix — the run's identity was carried loosely
through several independent async paths (WS frames, polling, refocus reconciliation)
rather than being the one thing every path keyed off consistently. Untangling that inside
the existing architecture meant auditing and fixing every one of those paths individually,
with no structural guarantee a twelfth path wouldn't have the same bug.

Meanwhile `0020-research-depth-and-budget-pacing.md`'s ordinary agentic loop had grown
budget tiers, pacing, and a "Go deeper" escalation — a *lot* of the durability and
mid-flight-steering machinery Deep Research needed, already built and already correct,
for a much smaller mechanism (one Lambda invocation, one round loop).

## Decision

- **Deep Research is an ordinary chat turn**, not a separate durable system. Setting
  `researchDepth: 'deep'` on a turn is enough — no new WS actions, no new DynamoDB item
  type, no plan-approval gate. The existing send/continue/escalate paths already cover it.
- **`run_research_task` is a sub-agent tool**, gated onto the tool list only when
  `researchDepth === 'deep'` and the calling context is not already inside a sub-agent
  (`ctx.subAgentDepth` unset) — a researcher can never spawn researchers. The orchestrator
  model decomposes the question into 2–6 independent sub-questions and issues them as
  parallel tool calls in one round; each call runs its own bounded `converseStream` loop
  (`extended` depth, web tools only, no memory/project tools) and returns a capped
  plain-text answer with inline citations — the sub-agent sees *only* the question text,
  nothing else from the parent chat.
- **A wall-clock deadline, not a round count, bounds the whole turn.** `sendMessage.ts`
  computes `deadlineAt` from the Lambda's own `context.getRemainingTimeInMillis()` minus a
  fixed reserve (`RESERVE_MS`, held back for final synthesis + persistence + enrichment).
  Every round of the loop — orchestrator and sub-agent alike — checks it and breaks rather
  than starting a round it can't finish; a live-only steering message tells the model to
  write up what it has instead of being killed mid-answer. This replaces per-stage Lambda
  timeouts and Step Functions' task-token pattern with one shared budget threaded down
  through `ToolContext.deadlineAt`.
- **Progress narrates live, not durably.** A sub-agent's tool calls are surfaced as
  `sub_agent_progress` WS chunks tagged with the parent `run_research_task` call's
  `toolUseId`, purely for UI feedback (the pill's "Searching: …" line) — dropping one
  costs nothing, since the finding itself lands as that tool call's own persisted
  `tool_result`. No separate progress-frame protocol, no reconnect replay.
- **No dossier, no project side effects.** A completed run is just an assistant turn with
  `run_research_task` tool-use/tool-result blocks in it, same as any other tool — nothing
  is written to a project, and there is no `hasResearch` flag or research-info section to
  keep in sync.

## Consequences

- The cross-chat state-bleed bug is structurally impossible now: there is no shared
  `activeResearch`-style state keyed loosely across async paths — a deep turn's state
  lives entirely inside its own `sendMessage.ts` invocation and its own chat's turn/tool
  rows, exactly like a brief or extended turn.
- Deep Research turns are wall-clock-bounded, not round-bounded — `ROUND_BUDGETS.deep` is
  still generous (12) since a deadline check makes an over-generous round count harmless.
- The Lambda timeout for `ws-sendMessage` had to rise (600s → 900s) to give a deep turn's
  parallel sub-agent fan-out room to actually finish before its own deadline forces the
  wrap-up message.
- A researcher sub-agent has no access to chat history, user/project memory, or project
  files — a deliberate narrowing (`0033`/`0038`'s "research runs see X" ADRs are all
  superseded, not reinstated) in exchange for the simplicity of "the sub-agent sees only
  the question text." Reintroducing any of that context would mean explicitly threading it
  into the question text at the call site, not giving the sub-agent its own read access.
- Losing durability across a Lambda timeout is an accepted trade: a deep turn that
  genuinely can't finish in ~13 minutes now ends with "wrap up now" rather than resuming
  seamlessly days later — judged acceptable since the old system's durability bought
  correctness problems that outweighed the benefit.
