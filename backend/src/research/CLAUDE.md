# Deep Research (Phase 3)

Status as of this file: **skeleton only** (task #8 done, #9 in progress). The state
machine deploys and all six states actually transition, but every handler is a stub —
none of them touch DynamoDB, Bedrock, or S3 yet. Read this file before touching anything
in this directory; it will be kept up to date as later tasks fill each handler in.

See root `CLAUDE.md`'s "Architecture decisions" pointer, `docs/adr/0023-deep-research-step-functions-orchestration.md`
for why this is a Step Functions state machine rather than a self-reinvoking Lambda, and
the plan doc (`docs/adr/` numbering continues from there — 0024 is the dossier ADR, not
yet written) for the full Phase 3 design. This file is the "how it works" companion to
those — it documents mechanics, not rationale; when the two would drift, the ADR wins and
this file should be corrected to match.

## Shape

```
Recon        cheap searches to find out what the question actually involves
Plan         clarifying questions + sub-questions, shown in chat
[approve]    user edits/approves via WS `researchApprove` — resumes the state machine
Wave         N researchers in parallel (Step Functions Map, MaxConcurrency 3)
Assess       supervisor reads all findings + steering notes -> more waves, or done
Report       synthesised, cited answer -> persisted as a normal assistant turn
```

`terraform/research.tf`'s `local.research_definition` is the literal ASL for this — read
it alongside this file, it's the actual source of truth for state names/transitions.
State names there (`Recon`, `Plan`, `AwaitApproval`, `Wave`, `Assess`, `AssessChoice`,
`Report`) are referenced below by the same names.

## Files

| File | State(s) | Status |
|------|----------|--------|
| `types.ts` | — | Shared `*Input`/`*Result` types, one pair per state. Every handler's signature is `(event: XInput) => Promise<XResult>` — Step Functions passes each state's `ResultPath`-merged JSON straight through as the next state's input, no envelope. |
| `recon.ts` | `Recon` | Stub. Will run 1-2 cheap `web_search`/`web_fetch` calls (reuse `lib/tools.ts`'s existing executors) to ground the Plan step in something more than the raw question. Task #10. |
| `plan.ts` | `Plan` | Stub. Will call Bedrock once (Sonnet, JSON out — same `safeParse`-wrapped pattern as `lib/search.ts`'s `searchHistory`) to produce `clarifyingQuestions` + `subQuestions` from the question + Recon's notes. Task #10. |
| `awaitApproval.ts` | `AwaitApproval` | Stub. Real job: persist `event.taskToken` onto the `RUN#` row (task #9) so the WS `researchApprove` action (task #11) can find it later and call `SendTaskSuccess`/`SendTaskFailure`. **Returning from this handler does not complete the state** — only a task-token call against a *different* Lambda invocation (the WS handler, not this one) does. Also worth emitting a WS frame here so the frontend shows the plan immediately (task #18). |
| `researcher.ts` | `Wave` (Map iterator) | Stub. Will run one bounded `converseStream` (`lib/llm/loop.ts`) over a single sub-question, same machinery `ws/sendMessage.ts` uses but with no WS connection — no delta streaming, just the final result. Reads `steeringNotes` at start (task #14). Task #12. |
| `assess.ts` | `Assess` | Stub. Supervisor call: reads all findings-so-far + pending steering notes, decides `done` or which gaps need another wave (`nextSubQuestions`). Also where steering notes get cleared once consumed (task #14). Task #13. |
| `report.ts` | `Report` | Stub. Synthesises the final cited answer, persists it as a normal assistant turn (task #15), and later (task #16) writes the full dossier — plan, every wave's findings with sources, every assessment, gaps deliberately dropped — as a project file. |

## Data model (not yet built — task #9)

Per the plan doc: `PK=CHAT#<chatId>` / `SK=RUN#<runId>` row carrying `status`
(`recon|planning|awaiting_approval|running|done|failed`), `plan`, wave/finding refs,
budget spent, `steeringNotes[]`, `connId`, the approval task token, timestamps. Large
researcher findings go to S3 under the existing `attachments/<sub>/<chatId>/…` prefix
(already covered by chat-delete/fork cascade) — only refs live in the row, to stay clear
of DynamoDB's 400 KB item limit. `deleteChatMessages` in `lib/dynamo.ts` currently only
sweeps `SK` begins_with `MSG#`; the cascade-delete cleanup Lambda
(`streams/chatTtlCleanup.ts`) needs to also sweep `RUN#` rows and their S3 findings, or
they leak on chat delete — this is part of task #9, not yet done.

## Invocation

Nothing starts a `chatrock-research-<env>` execution yet — that wiring (the composer's
Deep Research picker choice -> `StartExecution`, `terraform/iam.tf`'s
`StartResearchExecution` statement is the permission, not the call site) is task #19
(frontend) driving a not-yet-written WS action, most likely alongside task #11's
`researchApprove`.

## Env vars available to every handler

Same `local.lambda_env_base` every other backend Lambda gets (`terraform/lambda.tf`) —
`DYNAMO_TABLE`, Bedrock creds/region, `ATTACHMENTS_BUCKET`, etc. — since these Lambdas
share `aws_iam_role.lambda`, the same execution role as `ws/sendMessage.ts` and the HTTP
handlers. No research-specific env vars exist yet; the state machine's own ARN is not
currently injected into any Lambda's environment (not needed until something needs to
call `DescribeExecution`/`StopExecution` on itself, which no handler does today).

## Build

Each handler is its own esbuild entry point in `backend/esbuild.config.mjs`
(`research-recon`, `research-plan`, `research-awaitApproval`, `research-researcher`,
`research-assess`, `research-report`), bundled to `terraform/dist/<name>.zip` exactly like
every other Lambda in this repo — nothing special about these six.
