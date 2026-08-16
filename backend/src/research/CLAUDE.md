# Deep Research

Status as of this file: the state machine deploys and all six states transition, and the
`RUN#` DynamoDB row + cascade-delete are wired up. The six handlers below are otherwise
still stubs — none of them touch Bedrock yet. Read this file before touching anything in
this directory; it is kept up to date as each handler is filled in.

See root `CLAUDE.md`'s "Architecture decisions" pointer and
`docs/adr/0023-deep-research-step-functions-orchestration.md` for why this is a Step
Functions state machine rather than a self-reinvoking Lambda. This file is the "how it
works" companion to that ADR — it documents mechanics, not rationale; when the two would
drift, the ADR wins and this file should be corrected to match.

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
| `types.ts` | — | Shared `*Input`/`*Result` types, one pair per state, plus `RunRow` (the `RUN#` DynamoDB row shape). Every handler's signature is `(event: XInput) => Promise<XResult>` — Step Functions passes each state's `ResultPath`-merged JSON straight through as the next state's input, no envelope. |
| `recon.ts` | `Recon` | Stub. Runs 1-2 cheap `web_search`/`web_fetch` calls (reuse `lib/tools.ts`'s existing executors) to ground the Plan step in something more than the raw question. |
| `plan.ts` | `Plan` | Stub. Calls Bedrock once (Sonnet, JSON out — same `safeParse`-wrapped pattern as `lib/search.ts`'s `searchHistory`) to produce `clarifyingQuestions` + `subQuestions` from the question + Recon's notes. |
| `awaitApproval.ts` | `AwaitApproval` | Stub. Real job: persist `event.taskToken` onto the `RUN#` row so the WS `researchApprove` action can find it later and call `SendTaskSuccess`/`SendTaskFailure`. **Returning from this handler does not complete the state** — only a task-token call against a *different* Lambda invocation (the WS handler, not this one) does. Also worth emitting a WS frame here so the frontend shows the plan immediately. |
| `researcher.ts` | `Wave` (Map iterator) | Stub. Runs one bounded `converseStream` (`lib/llm/loop.ts`) over a single sub-question, same machinery `ws/sendMessage.ts` uses but with no WS connection — no delta streaming, just the final result. Reads `steeringNotes` at start. |
| `assess.ts` | `Assess` | Stub. Supervisor call: reads all findings-so-far + pending steering notes, decides `done` or which gaps need another wave (`nextSubQuestions`). Also where steering notes get cleared once consumed. |
| `report.ts` | `Report` | Stub. Synthesises the final cited answer, persists it as a normal assistant turn, and later writes the full dossier — plan, every wave's findings with sources, every assessment, gaps deliberately dropped — as a project file. |

## Data model

`PK=CHAT#<chatId>` / `SK=RUN#<runId>` row (`RunRow` in `types.ts`), managed by
`lib/dynamo.ts`'s `putRun`/`getRun`/`updateRun`/`appendRunSteeringNote`/`deleteChatRuns`:
`status` (`recon|planning|awaiting_approval|running|done|failed`), `plan`, findings,
`steeringNotes[]`, `roundsSpent`, `connId`, the approval task token, timestamps.
`updateRun` is a generic partial-update (every field aliased via
`ExpressionAttributeNames`, so any field name is safe to pass without checking DynamoDB
reserved words). Large researcher findings go to S3 under the existing
`attachments/<sub>/<chatId>/research/<runId>/…` prefix — only refs live in the row, to
stay clear of DynamoDB's 400 KB item limit.

**Cascade delete**: `streams/chatTtlCleanup.ts` calls `deleteChatRuns(chatId)` alongside
`deleteChatMessages`/`deleteChatObjects`/`deleteChatShares`. The S3 side needs no separate
sweep — `deleteChatObjects`'s prefix listing (`attachments/<sub>/<chatId>/…`) is
unqualified and therefore already recursive, so it picks up anything under the
`research/<runId>/` subpath for free.

## Invocation

Nothing starts a `chatrock-research-<env>` execution yet — that wiring (the composer's
Deep Research picker choice -> `StartExecution`, `terraform/iam.tf`'s
`StartResearchExecution` statement is the permission, not the call site) is a
not-yet-written WS action, most likely alongside `researchApprove`.

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
