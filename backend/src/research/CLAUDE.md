# Deep Research

Status as of this file: the state machine deploys and all six states transition, the
`RUN#` DynamoDB row + cascade-delete are wired up, Recon/Plan are implemented, the plan
approval gate works end to end over WebSocket, each Wave researcher runs a real bounded
investigation, the supervisor Assess handler drives the wave loop (more waves, or done)
with a working round cap, `ws/sendMessage.ts` intercepts mid-flight steering messages for
an active run, `report` synthesises the cited final answer, persists it as a normal
assistant turn, and writes the findings dossier as a project file, and a sensitive chat
gets neither — its findings stay chat-scoped and are read back via the
`read_research_findings` tool. The WS `startResearch` action starts a run, every state
pushes a best-effort progress frame, and `GET /api/chats/{chatId}/research` re-syncs a
client that missed one. Read this file before touching anything in this directory; it is
kept up to date as each handler is filled in.

See root `CLAUDE.md`'s "Architecture decisions" pointer and
`docs/adr/0023-deep-research-step-functions-orchestration.md` for why this is a Step
Functions state machine rather than a self-reinvoking Lambda. This file is the "how it
works" companion to that ADR — it documents mechanics, not rationale; when the two would
drift, the ADR wins and this file should be corrected to match.

## Shape

```
Recon        cheap searches to find out what the question actually involves
Plan         clarifying questions + sub-questions, shown in chat
[approve]    user approves (optionally with steering feedback) or revises via WS
             `researchApprove` — revise loops back through Replan into another Plan
Wave         N researchers in parallel (Step Functions Map, MaxConcurrency 3)
Assess       supervisor reads all findings + steering notes -> more waves, or done
Report       synthesised, cited answer -> persisted as a normal assistant turn
```

`terraform/research.tf`'s `local.research_definition` is the literal ASL for this — read
it alongside this file, it's the actual source of truth for state names/transitions.
State names there (`Recon`, `Plan`, `AwaitApproval`, `ApprovalChoice`, `Replan`, `Wave`,
`Assess`, `AssessChoice`, `Report`) are referenced below by the same names.

## Files

| File | State(s) | Status |
|------|----------|--------|
| `types.ts` | — | Shared `*Input`/`*Result` types, one pair per state, plus `RunRow` (the `RUN#` DynamoDB row shape). Every handler's signature is `(event: XInput) => Promise<XResult>` — Step Functions passes each state's `ResultPath`-merged JSON straight through as the next state's input, no envelope. |
| `recon.ts` | `Recon` | Runs one `web_search` call (via `lib/tools.ts`'s `executeTool`) to ground the Plan step in something more than the raw question. Notes are the search result's text entries; an error result yields `notes: []` rather than throwing. |
| `plan.ts` | `Plan`, `Replan` | Calls Bedrock once (`DEFAULT_CHAT_MODEL`, JSON out — same `safeParse`-wrapped pattern as `lib/search.ts`'s `searchHistory`, prompt in `prompts/research-plan.txt`) to produce `clarifyingQuestions` + `subQuestions`, either from the question + Recon's notes (`Plan`) or from the prior plan + the user's freetext feedback (`Replan`, when `event.priorPlan` is set — see "Plan approval gate" below). Sub-questions with no `question` text are dropped; a missing or duplicate `id` is replaced with a fresh `newId()`. |
| `awaitApproval.ts` | `AwaitApproval` | Persists `question`/`plan`/`taskToken` onto the `RUN#` row (via `updateRun`, upserting the row on its first write) with `status: 'awaiting_approval'` and the `findings`/`gapsNotPursued`/`steeringNotes`/`roundsSpent` defaults the downstream states need. **Returning from this handler does not complete the state** — only a task-token call against a *different* Lambda invocation, `ws/researchApprove.ts`, does. |
| `researcher.ts` | `Wave` (Map iterator) | Runs one bounded `converseStream` (`lib/llm/loop.ts`, `extended`/8-round budget) over a single sub-question, same machinery `ws/sendMessage.ts` uses but with only `web_search`/`web_fetch` enabled (no memory/project/image tools — a researcher has no chat context to draw on) and no WS connection to stream to. The system prompt (`prompts/research-researcher.txt`) asks for a final turn shaped as plain-text prose followed by a trailing `SOURCES: [...]` JSON-array line, parsed via a regex split rather than `safeParse`-over-the-whole-turn — nesting long free-text prose inside a JSON string is fragile (unescaped quotes/newlines routinely broke `JSON.parse`, observed live as raw JSON leaking into the `research_finding` summary). A turn with no `SOURCES:` line falls back to the legacy nested-JSON `{summary, sourceUrls}` shape (`safeParse`d like `plan.ts`), and if that also fails to parse, to `{summary: <raw text>, sourceUrls: []}` — never throws. Steering notes, if any, are appended to the sub-question in the initial user message. |
| `assess.ts` | `Assess` | Flattens this wave's raw `waveFindings` into `Finding[]` (`item.result.finding`), merges into the running `findings` total, then calls Bedrock once (`DEFAULT_CHAT_MODEL`, JSON out, prompt in `prompts/research-assess.txt`) to decide `done` vs. `nextSubQuestions` for another wave. `gapsNotPursued` accumulates across rounds; `steeringNotes` are cleared every round (consumed, not carried forward). Malformed model output falls back to `done: true` rather than looping forever. Like `AwaitApproval`, this state has no `ResultPath` — the handler's return value (`AssessResult`) is the *entire* next state, so it must re-emit every field `Wave`/`Report` need, not just its own verdict. |
| `report.ts` | `Report` | Calls Bedrock once (`DEFAULT_CHAT_MODEL`, plain markdown out — no `safeParse`, this is prose not JSON — prompt in `prompts/research-report.txt`) over the accumulated `findings`/`gapsNotPursued` to write the cited final answer, then persists it as a normal assistant turn: `getChat` for the chat's current `activeLeafId` (used as `parentId`, `null` if unset), `putMessage` with a fresh `msgId`/`responseId` (same `uuidv4()` convention `ws/sendMessage.ts` uses for turn ids, not `newId()`), then `updateChatActiveLeaf` so it becomes the new leaf. `updateRun` sets `status: 'done'` and stores `reportText` on the `RUN#` row in the same call. Then `writeDossier()` writes the findings as a project file — see "The research dossier" below. |
| `ws/startResearch.ts` | — (starts the execution) | WS action `startResearch`, outside the state machine itself. Mints a `runId` (`newId()`), writes the initial `RUN#` row (`status: 'recon'`), and calls `StartExecutionCommand` with `{chatId, runId, sub, question, connId}` as the execution input — see "Invocation" below. |

## Data model

`PK=CHAT#<chatId>` / `SK=RUN#<runId>` row (`RunRow` in `types.ts`), managed by
`lib/dynamo.ts`'s `putRun`/`getRun`/`getActiveRun`/`updateRun`/`appendRunSteeringNote`/
`deleteChatRuns`:
`status` (`recon|planning|awaiting_approval|running|done|failed`), `plan`, findings,
`steeringNotes[]`, `roundsSpent`, `connId`, the approval task token, `reportText` (set by
`report.ts` alongside `status: 'done'`), timestamps.
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

The composer's Deep Research picker sends WS action `startResearch` — `{chatId, question}`
— to `ws/startResearch.ts` (`terraform/iam.tf`'s `StartResearchExecution` statement is
what lets it call `StartExecutionCommand`). It 410s on a gone connection and 400s on a
missing/blank `chatId`/`question`; on success it writes the `RUN#` row and starts the
`chatrock-research-<env>` execution at `Recon`, returning `{runId}`. The connecting
Lambda's own `connId` is threaded into the execution input from here (see "Progress frames
and reconnect" below) — no other Lambda originates it.

## The wave loop

`Wave`'s `ItemsPath` is `$.nextSubQuestions`, not `$.plan.subQuestions` — the first wave
researches the approved plan (`researchApprove.ts` seeds `nextSubQuestions` from
`plan.subQuestions` in its `SendTaskSuccess` output), but every subsequent wave researches
whatever `assess.ts` decided still has a gap. A `Map` item is otherwise just the bare
`SubQuestion` from `ItemsPath`, so `Wave`'s `Parameters` (`terraform/research.tf`) injects
`chatId`/`runId`/`sub`/`steeringNotes` onto each item to match `ResearcherInput`.

The `Wave` Map state's iterator (`local.research_wave_iterator`) merges each `Researcher`
task's `ResearcherResult` (`{finding: Finding}`) into the per-item state at `$.result`,
preserving the item's own `subQuestion`/`steeringNotes` fields alongside it — so `Wave`'s
`ResultPath` (`$.waveFindings`, deliberately *not* `$.findings`) collects an array of
`{subQuestion, steeringNotes, result: {finding}}`, not a plain `Finding[]`. Keeping it out
of `$.findings` matters: `$.findings` is the *accumulated* total across every wave so far,
and `assess.ts` merges this round's `waveFindings` into it — if `Wave` wrote straight to
`$.findings`, each wave's `ResultPath` replace-not-merge would clobber every earlier wave's
findings instead of adding to them.

`Assess` has an explicit `Parameters` payload (chatId/runId/sub/question/plan/findings/
waveFindings/gapsNotPursued/steeringNotes/roundsSpent) rather than passing the ambient
state through unshaped — see "Plan approval gate" below for why `assess.ts`'s return value
has to reconstruct the *entire* next state regardless. `AssessChoice` reads `$.done` and
`$.roundsSpent` straight off that reconstructed state (both are now genuinely live: `done`
is the supervisor's verdict, `roundsSpent` increments every Assess call), routing back to
`Wave` (default) or on to `Report`.

## Mid-flight steering

`ws/sendMessage.ts` intercepts a `content`-bearing send (a genuine new message — `continue`/
`rerun` never carry `content`, so both are already excluded) by checking
`dynamo.ts`'s `getActiveRun(chatId)` (queries `PK=CHAT#<chatId>`/`begins_with(SK, 'RUN#')`,
returns the first row whose `status` isn't `done`/`failed` — at most one run is ever active
per chat by product design) before doing anything else with it. If a run is active, the
message does **not** start a normal turn: it's persisted as a plain user turn (chained under
the chat's current `activeLeafId` regardless of any `parentId` the client sent — a steering
message talks to the running supervisor, it doesn't branch the tree), `activeLeafId` is
advanced, and the text is appended to the run's `steeringNotes[]` via
`appendRunSteeringNote` (list-append, race-safe — see "Data model" above). The client gets a
`research_steering_noted` WS frame (`runId`, `msgId`) instead of the normal streaming
sequence; no Bedrock call happens on this path. `researcher.ts` reads pending notes at the
start of each `Wave` iteration; `assess.ts` reads and clears them when deciding the next
wave (see "The wave loop" above).

## The research dossier

Why every run keeps its findings as a project file, why a missing project gets created
rather than the findings staying chat-scoped, and why the dossier is built from merged
findings rather than full per-wave history: `docs/adr/0024-research-dossier-as-a-project-file.md`.

`report.ts`'s `writeDossier()` runs after the turn/run writes. It resolves the target
project from `chat.projectId`; if unset, it creates one (`putProject`, named from
`event.question.slice(0, 80)`) and moves the chat into it with the same three calls
`http/chats.ts`'s `PATCH .../projectId` uses for a user-initiated move
(`updateChatProject`, `summarizeChatById`, `enrichProjectFactsByChatId`) — so a Deep
Research run has identical side effects to a manual move. `buildDossierMarkdown()` renders
the final report, plan (clarifying questions + sub-questions), each merged finding with its
source URLs, and gaps not pursued into one markdown document, written directly to S3
(`projectFilePrefix(sub, projectId)<fileId>/research-dossier.md`, a plain `PutObjectCommand`
— there's no client to drive the presigned-PUT flow `http/projects.ts`'s file routes use)
then run through `lib/projectFiles.ts`'s `summarizeFile()` for `microLabel`/`summary`
exactly like an uploaded file, and written straight to `status: 'ready'` (no
`uploading`/`processing` intermediate — those states exist for the client round-trip this
path doesn't have). `inclusion: 'auto'`, so it costs only a manifest line until something
reads it.

`writeDossier()` is skipped outright for a sensitive chat (`chat?.sensitive` check ahead
of the call in `handler`, not a branch buried inside `writeDossier` itself) — no project,
no dossier file. Its findings stay reachable only from within the chat, via
`read_research_findings` (`lib/researchFindings.ts`): gated on `ToolContext.sensitive` in
`toolGating.ts` (offered only when `ctx.chatId && ctx.sensitive`), it pulls the most
recently completed run for the chat via `listRuns(chatId)` (`lib/dynamo.ts`) and renders
the same report/plan/findings/gaps shape as the dossier, at `summary` or `full` detail.

## Plan approval gate

`AwaitApproval` (`terraform/research.tf`) uses `.waitForTaskToken` and has no
`ResultPath`, so whatever `ws/researchApprove.ts` sends via `SendTaskSuccess` becomes the
*entire* state for whatever comes next — not a merge with what came before.

The WS `researchApprove` action takes `decision: 'approve' | 'revise'` plus an optional
freetext `feedback` — named `decision`, not `action`, since the envelope's own
`action: 'researchApprove'` is what API Gateway's `route_selection_expression`
(`$request.body.action`, `terraform/apigw_ws.tf`) matches on; reusing that key for the
approve/revise choice would collide with routing. There is no "reject" — a user who
dislikes the plan just abandons the chat; `AwaitApproval`'s 24h `TimeoutSeconds` fails the
run cleanly on its own, so cleanup doesn't depend on a button click nobody reliably
presses.

- **`approve`** reconstructs `chatId`/`runId`/`sub`/`question`/`plan` plus fresh
  `findings: []`/`nextSubQuestions: plan.subQuestions`/`gapsNotPursued: []`/
  `roundsSpent: 0`, transitions the row to `running`, and starts `Wave`. If `feedback` is
  present it seeds `steeringNotes: [feedback]` instead of `[]` — "approve, but also keep
  this in mind" doesn't need a full replan.
- **`revise`** sends `{revise: true, feedback, plan, ...}` and moves the row to `planning`
  until the next `AwaitApproval` visit writes `awaiting_approval` back — the superseded plan
  must stop being offered, and the status guard below is what makes a second decision fail
  cleanly instead of racing the token rotation. `ResearchPanel.tsx` mirrors that transition
  optimistically as it sends, for both decisions, so the panel never re-offers a plan the
  user has already acted on. `ApprovalChoice` (`terraform/research.tf`) branches on `$.revise` to
  `Replan` — the same `plan.ts` handler, invoked with `priorPlan`/`feedback` instead of
  `recon` (see plan.ts's header comment) — which produces a revised plan and loops back into
  `AwaitApproval`, minting a fresh task token for a second wait cycle. `ApprovalChoice`
  falls through to `Wave` when `$.revise` is absent (the `approve` path never sets it).

`researchApprove.ts` trusts `getConnection(connId).userSub` (the pattern every WS action
handler post-`$connect` uses) for the ownership check against the `RUN#` row's `sub`. A
`status !== 'awaiting_approval'` or missing `taskToken` on the row is a 409, guarding
against a stale or replayed approval; a `revise` with blank/missing `feedback` is a 400.

## Progress frames and reconnect

Every state pushes a best-effort WS frame via `lib/wsNotify.ts`'s `notifyConnection(connId,
data)`, which swallows any failure (dead/expired connection, etc.) — the `RUN#` row is
always the source of truth, these frames are a live-UI convenience only:

| `type` | Pushed by | Payload |
|--------|-----------|---------|
| `research_plan` | `plan.ts` | `runId`, `chatId`, `plan: {subQuestions, clarifyingQuestions}` |
| `research_wave_start` | `researchApprove.ts` (first wave), `assess.ts` (subsequent waves) | `runId`, `chatId`, `subQuestions` |
| `research_finding` | `researcher.ts`, once per sub-question | `runId`, `chatId`, `subQuestionId`, `summary`, `sourceUrls` |
| `research_assess` | `assess.ts`, every round | `runId`, `chatId`, `findingCount`, `done` |
| `research_done` | `report.ts` | `runId`, `chatId`, `msgId`, `projectId` |
| `research_phase` | `progress.ts`'s `notifyPhase`, called by `recon.ts`/`plan.ts`/`assess.ts`/`report.ts` | `runId`, `chatId`, `phase` (`recon\|planning\|assessing\|reporting\|dossier`), `detail?` |
| `research_step` | `progress.ts`'s `notifyStep`, called directly by `recon.ts` and via `stepEmitter` by `researcher.ts` | `runId`, `chatId`, `subQuestionId?`, `step` (one `thinking` or `tool` step, shaped as the frontend's own `Step`) |

**Live progress** (`progress.ts`) — why step boundaries rather than forwarding the token
stream, and why steps are never persisted:
`docs/adr/0027-research-progress-as-step-boundary-frames.md`. `stepEmitter(ctx,
subQuestionId)` is the single place a `converseStream` `StreamChunk` is translated into a
`research_step`: it accumulates `thinking_delta`s and emits one step on `thinking_done`,
and emits a tool step twice — once on `tool_call`, once complete on `tool_result` (whose
chunk carries no `name`/`input`, so the in-flight call is held to re-emit the whole step;
the client upserts by `toolUseId`). Tool results are previewed at `STEP_RESULT_PREVIEW`
(2000 chars) rather than sent whole. `delta`/`heartbeat`/`stop`/`turn`/`usage` carry
nothing a pill shows and are ignored. Phases that call `converseOnce` (`plan`, `assess`,
`report`) yield no chunks at all and so emit only `research_phase`; `recon.ts` makes a bare
`executeTool` call with no loop around it, so it emits its pending/resolved step pair
through `notifyStep` directly. `research_step` frames are **not** part of the re-sync
endpoint's response — a client that reconnects mid-run picks progress up from the next
frame.

**`connId` provenance**: `startResearch.ts` sets it initially from the connection that
started the run. `researchApprove.ts` refreshes it to whichever connection performed the
approval, since that may be a different tab/reconnect than the original starter — both
persist it back to the `RUN#` row via `updateRun` and re-emit it in their state output.
Because `AwaitApproval`'s `SendTaskSuccess` and `Assess`'s return value both replace the
*entire* next state (no `ResultPath` — see "Plan approval gate" above and "The wave loop"),
omitting `connId` from either would silently drop it from every downstream state; both
`researchApprove.ts` and every branch of `assess.ts` explicitly re-emit it for this reason.
`awaitApproval.ts`'s own `updateRun` call does not touch `connId` — it passively inherits
whatever `startResearch.ts` originally wrote, which is what's wanted since no connection
has re-approved anything at that point yet.

**Re-sync**: `assess.ts` also writes `findings`/`gapsNotPursued`/`roundsSpent` to the
`RUN#` row via `updateRun` on every round (both the parse-error and success branches) —
without this, the row only changes at `awaitApproval.ts` (first write) and `report.ts`
(terminal), leaving every intermediate wave invisible to a client that reconnects mid-run.
`GET /api/chats/{chatId}/research` (`http/chats.ts`) reads that row back: it prefers
`getActiveRun(chatId)` (the in-flight run, if any), falling back to the most recently
created row from `listRuns(chatId)` so a client that reconnects just after a run finished
still sees the completed report rather than `{run: null}`. Phase 2's refocus handler
(`frontend/src/api/ws.ts`) calls this route to catch up on anything a dropped WS frame
missed.

## Env vars available to every handler

Same `local.lambda_env_base` every other backend Lambda gets (`terraform/lambda.tf`) —
`DYNAMO_TABLE`, Bedrock creds/region, `ATTACHMENTS_BUCKET`, etc. — since these Lambdas
share `aws_iam_role.lambda`, the same execution role as `ws/sendMessage.ts` and the HTTP
handlers. `lib/wsNotify.ts` additionally reads `WS_MANAGEMENT_ENDPOINT` (part of
`lambda_env_base`) to construct its `ApiGatewayManagementApiClient` — every research
handler that calls `notifyConnection` relies on this. `ws/startResearch.ts` is the only
Lambda in this directory with its own extra env var, `RESEARCH_STATE_MACHINE_ARN`, since
it's the one that calls `StartExecution`; every other research Lambda just runs as a Task
the state machine invokes and never needs its own ARN.

## Build

Each handler is its own esbuild entry point in `backend/esbuild.config.mjs`
(`research-recon`, `research-plan`, `research-awaitApproval`, `research-researcher`,
`research-assess`, `research-report`, plus `ws-startResearch` for the WS action that
starts the execution), bundled to `terraform/dist/<name>.zip` exactly like every other
Lambda in this repo — nothing special about these.
