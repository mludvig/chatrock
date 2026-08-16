# Deep Research

Status as of this file: the state machine deploys and all six states transition, the
`RUN#` DynamoDB row + cascade-delete are wired up, Recon/Plan are implemented, and the
plan approval gate works end to end over WebSocket. `researcher`/`assess`/`report` are
still stubs. Read this file before touching anything in this directory; it is kept up to
date as each handler is filled in.

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
| `recon.ts` | `Recon` | Runs one `web_search` call (via `lib/tools.ts`'s `executeTool`) to ground the Plan step in something more than the raw question. Notes are the search result's text entries; an error result yields `notes: []` rather than throwing. |
| `plan.ts` | `Plan` | Calls Bedrock once (`DEFAULT_CHAT_MODEL`, JSON out — same `safeParse`-wrapped pattern as `lib/search.ts`'s `searchHistory`, prompt in `prompts/research-plan.txt`) to produce `clarifyingQuestions` + `subQuestions` from the question + Recon's notes. Sub-questions with no `question` text are dropped; a missing or duplicate `id` is replaced with a fresh `newId()`. |
| `awaitApproval.ts` | `AwaitApproval` | Persists `question`/`plan`/`taskToken` onto the `RUN#` row (via `updateRun`, upserting the row on its first write) with `status: 'awaiting_approval'` and the `findings`/`gapsNotPursued`/`steeringNotes`/`roundsSpent` defaults the downstream states need. **Returning from this handler does not complete the state** — only a task-token call against a *different* Lambda invocation, `ws/researchApprove.ts`, does. |
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
Deep Research picker choice -> `StartExecution`; `terraform/iam.tf`'s
`StartResearchExecution` statement is the permission, not the call site) is a
not-yet-written WS action.

## Plan approval gate

`AwaitApproval` (`terraform/research.tf`) uses `.waitForTaskToken` and has no
`ResultPath`, so whatever `ws/researchApprove.ts` sends via `SendTaskSuccess` becomes the
*entire* state for `Wave`/`Assess`/`Report` — not a merge with what came before. That's why
`researchApprove.ts` reconstructs `chatId`/`runId`/`sub`/`question`/`plan` plus fresh
`findings: []`/`gapsNotPursued: []`/`steeringNotes: []`/`roundsSpent: 0`, rather than
sending just the (possibly user-edited) plan.

`researchApprove.ts` trusts `getConnection(connId).userSub` (the pattern every WS action
handler post-`$connect` uses) for the ownership check against the `RUN#` row's `sub`, then
either `SendTaskFailureCommand` (rejected — transitions the row to `failed`) or
`SendTaskSuccessCommand` (approved, optionally with an edited plan — transitions the row to
`running`). A `status !== 'awaiting_approval'` or missing `taskToken` on the row is a 409,
guarding against a stale or replayed approval.

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
