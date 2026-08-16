# 23. Deep Research: Step Functions orchestration

## Status

Accepted

## Context

Deep Research (Phase 3) needs a run that can span minutes to tens of minutes, survive a
Lambda dying or timing out mid-run, support a human-in-the-loop approval gate before
spending real work, run several researchers in parallel per wave, and be resumable from
wherever it left off if the browser is closed and reopened later.

The obvious cheap option is a Lambda that re-invokes itself (or is re-invoked by an
EventBridge rule) between steps, checkpointing state to DynamoDB. The honest failure mode
of that design: Lambda's async (`Event`) invocation retries twice on function error or
timeout, resuming from the last DynamoDB checkpoint — but after those two retries are
exhausted, the run is simply orphaned in `running` forever. Recovering from that needs a
sweeper (EventBridge rule scanning for stale `RUN#` rows past some staleness threshold)
plus a DLQ drain path for the rare invocations that fail permanently. That is reimplementing
a workflow engine's retry/timeout/resume semantics, badly, as bespoke DynamoDB polling code.

## Decision

Orchestrate with an AWS Step Functions **Standard** workflow (`terraform/research.tf`).
Retry, timeout, and resume become the platform's job instead of hand-rolled polling:

- **Agent logic stays in ordinary Lambdas.** `backend/src/research/*.ts` — `recon.ts`,
  `plan.ts`, `awaitApproval.ts`, `researcher.ts`, `assess.ts`, `report.ts` — each a plain
  Task-state handler taking JSON in, returning JSON out. ASL only orchestrates; there is no
  "research engine" module to maintain in parallel with the state machine.
- **`Map` for parallel researchers.** The `Wave` state runs one `researcher` Task per
  sub-question, `MaxConcurrency: 3` — no hand-rolled fan-out/fan-in.
- **`.waitForTaskToken` for the approval gate.** `AwaitApproval` invokes `awaitApproval.ts`
  with `$$.Task.Token` injected into its payload; the Lambda persists the token and returns
  immediately, and the *state* only completes when a later `SendTaskSuccess`/`SendTaskFailure`
  call — the WS `researchApprove` action, task #11 — targets that token. 24h `TimeoutSeconds`
  so an abandoned plan fails cleanly instead of hanging the execution forever.
- **A `Choice` state backstops the wave loop**, not the supervisor: `Assess` decides
  `done` based on the research question, but `AssessChoice` also forces `Report` once
  `roundsSpent >= 8` regardless of what the supervisor says, matching the plan's "hard
  total-researcher-round cap is the backstop against a runaway" note.
- **Shared IAM, not a new execution role for the Lambdas.** The research handlers use the
  existing `aws_iam_role.lambda` (same DynamoDB/Bedrock/S3 access as every other backend
  Lambda) — only the *state machine's own* role (`research_sfn`, assumed by
  `states.amazonaws.com`) is new, scoped to `lambda:InvokeFunction` on just these six
  functions. The shared Lambda role additionally gets `states:StartExecution` (scoped to
  this one state machine) and `states:SendTaskSuccess/Failure/Heartbeat` (unscoped — AWS
  doesn't support resource-scoping these three actions by ARN; the target is identified by
  the opaque task token, not a resource).

## Consequences

- No sweeper, no DLQ-drain path, no orphaned-run cleanup code — an execution that dies mid-run
  is Step Functions' problem to retry or fail, and its state is always inspectable via
  `DescribeExecution` (wired into task #18's re-sync endpoint) rather than reconstructed from
  DynamoDB checkpoints.
- Every state in `terraform/research.tf`'s `research_definition` is a plain literal ASL
  object rather than a Terraform-native DSL — this is normal for `aws_sfn_state_machine`
  (there is no first-class ASL resource type) and keeps the whole pipeline visible in one
  file, at the cost of no compile-time checking of state names/transitions until `apply`.
- The six Lambda handlers in `backend/src/research/` each validate their input shape and
  return a well-formed result for their state — Recon → Plan → approval-wait → Wave →
  Assess → Report all transition end to end, with the Choice-state round cap above as the
  backstop against a runaway wave loop.
