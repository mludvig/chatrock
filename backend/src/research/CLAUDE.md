# Deep Research

Status as of this file: the state machine deploys and all six states transition, the
`RUN#` DynamoDB row + cascade-delete are wired up, Recon/Plan are implemented, the plan
approval gate works end to end over WebSocket, each Wave researcher runs a real bounded
investigation, the supervisor Assess handler drives the wave loop (more waves, or done)
with a working round cap, `ws/sendMessage.ts` intercepts mid-flight steering messages for
an active run, `report` synthesises the cited final answer, persists it as a normal
assistant turn, and keeps the findings on the `RUN#` row, read back via the
`read_research_findings` tool. A run never creates a project (docs/adr/0031). The WS `startResearch` action starts a run, every state
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
| `model.ts` | — | `resolveRunModel(event)`: the run's model, read back from the `RUN#` row, with a `DEFAULT_CHAT_MODEL` fallback. Called by every phase that makes an LLM call — see "The run's model" below. |
| `recon.ts` | `Recon` | Runs one `web_search` call (via `lib/tools.ts`'s `executeTool`) to ground the Plan step in something more than the raw question. Notes are the search result's text entries; an error result yields `notes: []` rather than throwing. |
| `plan.ts` | `Plan`, `Replan` | Calls Bedrock once (the run's model, JSON out — same `safeParse`-wrapped pattern as `lib/search.ts`'s `searchHistory`, prompt in `prompts/research-plan.txt`) to produce `clarifyingQuestions` + `subQuestions`, either from the question + Recon's notes (`Plan`) or from the prior plan + the user's freetext feedback (`Replan`, when `event.priorPlan` is set — see "Plan approval gate" below). Sub-questions with no `question` text are dropped; a missing or duplicate `id` is replaced with a fresh `newId()`. |
| `awaitApproval.ts` | `AwaitApproval` | Persists `question`/`plan`/`taskToken` onto the `RUN#` row (via `updateRun`, upserting the row on its first write) with `status: 'awaiting_approval'` and the `findings`/`gapsNotPursued`/`steeringNotes`/`roundsSpent` defaults the downstream states need. Then writes the plan as an ordinary assistant turn (numbered clarifying questions + numbered sub-questions) at the chat's active leaf and pushes the `research_plan` frame — the frame comes from here, not `plan.ts`, so the client is only told about a plan it can already reload. **Returning from this handler does not complete the state** — only a task-token call against a *different* Lambda invocation (`lib/researchApproval.ts`, via `ws/researchApprove.ts` or a composer reply) does. |
| `researcher.ts` | `Wave` (Map iterator) | Runs one bounded `converseStream` (`lib/llm/loop.ts`, `extended`/8-round budget) over a single sub-question, same machinery `ws/sendMessage.ts` uses but with only `web_search`/`web_fetch` enabled (no memory/project/image tools — a researcher has no chat context to draw on) and no WS connection to stream to. The system prompt (`prompts/research-researcher.txt`) asks for a final turn shaped as plain-text prose followed by a trailing `SOURCES: [...]` JSON-array line, parsed via a regex split rather than `safeParse`-over-the-whole-turn — nesting long free-text prose inside a JSON string is fragile (unescaped quotes/newlines routinely broke `JSON.parse`, observed live as raw JSON leaking into the `research_finding` summary). A turn with no `SOURCES:` line falls back to the legacy nested-JSON `{summary, sourceUrls}` shape (`safeParse`d like `plan.ts`), and if that also fails to parse, to `{summary: <raw text>, sourceUrls: []}` — never throws. Steering notes, if any, are appended to the sub-question in the initial user message. |
| `assess.ts` | `Assess` | Flattens this wave's raw `waveFindings` into `Finding[]` (`item.result.finding`), merges into the running `findings` total, then calls Bedrock once (the run's model, JSON out, prompt in `prompts/research-assess.txt`) to decide `done` vs. `nextSubQuestions` for another wave. `gapsNotPursued` accumulates across rounds; `steeringNotes` are cleared every round (consumed, not carried forward). Malformed model output falls back to `done: true` rather than looping forever. Like `AwaitApproval`, this state has no `ResultPath` — the handler's return value (`AssessResult`) is the *entire* next state, so it must re-emit every field `Wave`/`Report` need, not just its own verdict. |
| `report.ts` | `Report` | Calls Bedrock once (the run's model, plain markdown out — no `safeParse`, this is prose not JSON — prompt in `prompts/research-report.txt`) over the accumulated `findings`/`gapsNotPursued` to write the cited final answer. `citations.ts`'s `linkifyReportCitations()` deterministically rewrites the model's `[n]` markers and its `n. <url>`-format Sources list into markdown links before anything is persisted — parsing the model's own link syntax was judged less reliable than a plain URL list. The (linkified) report is then persisted as a normal assistant turn: `getChat` for the chat's current `activeLeafId` (used as `parentId`, `null` if unset), `putMessage` with a fresh `msgId`/`responseId` (same `uuidv4()` convention `ws/sendMessage.ts` uses for turn ids, not `newId()`), then `updateChatActiveLeaf` so it becomes the new leaf. `updateRun` sets `status: 'done'` and stores `reportText` on the `RUN#` row in the same call. Deep Research bypasses `ws/sendMessage.ts` entirely, so its own `chat.title === 'New Chat'` title-gen call never fires — `report.ts` runs the same `generateChatTitle()` call itself right after persisting the turn, and pushes `titleUpdated` the same way. `updateChatHasResearch` then unlocks `read_research_findings` on the chat. A dossier file is written only when the chat already belongs to a project — see "The research dossier" below. |
| `ws/startResearch.ts` | — (starts the execution) | WS action `startResearch`, outside the state machine itself. Persists the question as a normal user turn (`putMessage`, chained under the chat's current `activeLeafId`) and advances `activeLeafId` to it — the same durability the question would get from a normal send, and what `report.ts`'s final answer chains under — then mints a `runId` (`newId()`), writes the initial `RUN#` row (`status: 'recon'`, `model` snapshotted from the chat — see "The run's model" below), and calls `StartExecutionCommand` with `{chatId, runId, sub, question, connId}` as the execution input — see "Invocation" below. |

## Data model

`PK=CHAT#<chatId>` / `SK=RUN#<runId>` row (`RunRow` in `types.ts`), managed by
`lib/dynamo.ts`'s `putRun`/`getRun`/`getActiveRun`/`updateRun`/`appendRunSteeringNote`/
`deleteChatRuns`:
`status` (`recon|planning|awaiting_approval|running|done|failed`), `model` (see "The run's
model" below), `plan`, findings, `steeringNotes[]`, `roundsSpent`, `connId`, the approval task token, `reportText` (set by
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

## The run's model

Every LLM call in a run — `plan`, each `researcher`, `assess`, `report` — uses the chat's
model, not a fixed default and not a per-stage tier. Why, and why it is read back from the
`RUN#` row rather than threaded through the state machine like `connId`:
`docs/adr/0030-research-runs-use-the-chats-model.md`.

`ws/startResearch.ts` snapshots `chat.model` onto the `RUN#` row (falling back to
`DEFAULT_CHAT_MODEL` for a retired id, the same self-heal `http/chats.ts`'s
`resolveChatModel()` does). `research/model.ts`'s `resolveRunModel(event)` reads it back —
one `GetItem`, same fallback — and every phase handler calls it before its own
`converseOnce`/`converseStream`. `report.ts` also stamps it on the assistant turn it
persists, so the transcript records the model that actually wrote the report.

## Mid-flight steering

`ws/sendMessage.ts` intercepts a `content`-bearing send (a genuine new message — `continue`/
`rerun` never carry `content`, so both are already excluded) by checking
`dynamo.ts`'s `getActiveRun(chatId)` (queries `PK=CHAT#<chatId>`/`begins_with(SK, 'RUN#')`,
returns the first row whose `status` isn't `done`/`failed` — at most one run is ever active
per chat by product design) before doing anything else with it. If a run is active, the
message does **not** start a normal turn: it's persisted as a plain user turn (chained under
the chat's current `activeLeafId` regardless of any `parentId` the client sent — a message to
the running supervisor doesn't branch the tree) and `activeLeafId` is advanced. What happens
next depends on the run's status: `awaiting_approval` sends it to the approval gate (see
"Plan approval gate" below), anything else appends it to the run's `steeringNotes[]` via
`appendRunSteeringNote` (list-append, race-safe — see "Data model" above) and answers with a
`research_steering_noted` WS frame (`runId`, `msgId`) instead of the normal streaming
sequence. No Bedrock chat call happens on either path. `researcher.ts` reads pending notes at the
start of each `Wave` iteration; `assess.ts` reads and clears them when deciding the next
wave (see "The wave loop" above).

## The research dossier

Why a run never creates a project, and why the dossier is built from merged findings rather
than full per-wave history: `docs/adr/0031-deep-research-is-not-a-project.md`.

A completed run's full record lives on the `RUN#` row. `read_research_findings`
(`lib/researchFindings.ts`) is how it is read back: `toolGating.ts` offers it whenever
`ctx.chatId && ctx.hasResearch`, where `hasResearch` comes from the chat row's flag that
`report.ts` sets via `updateChatHasResearch` when the run finishes. It pulls the most
recently completed run for the chat via `listRuns(chatId)` and renders the report, plan,
findings with sources, and gaps at `summary` or `full` detail. For the user, the same
document is rendered on demand by `GET /api/chats/{chatId}/research?dossier=1` and
downloadable from `ChatDetailsDialog`'s Info tab.

`lib/researchDossier.ts` additionally files that document as a project file, but only for a
chat that already belongs to a project — `report.ts` calls `writeResearchDossier()` when
`chat.projectId` is set and the chat isn't sensitive, and `http/chats.ts`'s
`PATCH .../projectId` calls `writeDossiersForChatMove()` when a chat with a completed run is
moved into one. Each write records `dossierProjectId` on the run row, so moving a chat
between projects files one copy per project rather than duplicates. The markdown is written
directly to S3 (`projectFilePrefix(sub, projectId)<fileId>/research-dossier.md`, a plain
`PutObjectCommand` — there's no client to drive the presigned-PUT flow `http/projects.ts`'s
file routes use), then run through `lib/projectFiles.ts`'s `summarizeFile()` for
`microLabel`/`summary` exactly like an uploaded file, and written straight to
`status: 'ready'` (no `uploading`/`processing` intermediate — those states exist for the
client round-trip this path doesn't have). `inclusion: 'auto'`, so it costs only a manifest
line until something reads it.

A sensitive chat never gets a dossier file even inside a project — its findings stay on the
`RUN#` row, reachable only from within the chat.

## Plan approval gate

`AwaitApproval` (`terraform/research.tf`) uses `.waitForTaskToken` and has no
`ResultPath`, so whatever `ws/researchApprove.ts` sends via `SendTaskSuccess` becomes the
*entire* state for whatever comes next — not a merge with what came before.

Two things reach that token, both through `lib/researchApproval.ts`'s
`resolvePlanApproval()` (which owns the `SendTaskSuccess` payloads, the row transition and
the stale-token retry loop): the panel's Approve button via the WS `researchApprove` action,
and a reply typed into the main composer via `ws/sendMessage.ts`. The panel has no feedback
box of its own — it scrolls off small screens while the composer doesn't, so answers went to
the composer and stalled the run as steering notes. `lib/planFeedback.ts`'s
`classifyPlanFeedback()` decides what a composer reply means with one `TINY_MODEL` call —
`approve` (bare consent), `approve_with_steering` (consent plus guidance, passed as
`feedback` on an approve) or `revise` — falling back to `revise` on any failure, and the
client is told which via a `research_plan_decision` frame. A reply that arrives just after
the run left the gate falls through to the steering path instead.
See `docs/adr/0032-plan-feedback-classified-by-a-tiny-model.md`.

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
  cleanly instead of racing the token rotation. The frontend mirrors that transition as it
  sends (`ResearchPanel.tsx`'s Approve button) or when `research_plan_decision` lands (a
  composer reply), so the panel never re-offers a plan the user has already acted on.
  `plan.ts` renders the prior plan for `Replan` as numbered lists matching the numbering
  `awaitApproval.ts` persisted the plan turn with, so feedback like "#1 I mean xyz" resolves
  to the right item. A revised plan is a second assistant turn beneath the feedback that
  asked for it, not a replacement of the first.
  `ApprovalChoice` (`terraform/research.tf`) branches on `$.revise` to
  `Replan` — the same `plan.ts` handler, invoked with `priorPlan`/`feedback` instead of
  `recon` (see plan.ts's header comment) — which produces a revised plan and loops back into
  `AwaitApproval`, minting a fresh task token for a second wait cycle. `ApprovalChoice`
  falls through to `Wave` when `$.revise` is absent (the `approve` path never sets it).

`researchApprove.ts` trusts `getConnection(connId).userSub` (the pattern every WS action
handler post-`$connect` uses) for the ownership check against the `RUN#` row's `sub`;
`sendMessage.ts` has already resolved the same `sub` for the send itself. A
`status !== 'awaiting_approval'` or missing `taskToken` on the row is a 409, guarding
against a stale or replayed approval; a `revise` with blank/missing `feedback` is a 400.

## Progress frames and reconnect

Every state pushes a best-effort WS frame via `lib/wsNotify.ts`'s `notifyConnection(connId,
data)`, which swallows any failure (dead/expired connection, etc.) — the `RUN#` row is
always the source of truth, these frames are a live-UI convenience only:

| `type` | Pushed by | Payload |
|--------|-----------|---------|
| `research_plan` | `awaitApproval.ts` | `runId`, `chatId`, `plan: {subQuestions, clarifyingQuestions}`, `msgId` (the assistant turn the plan was persisted as) |
| `research_wave_start` | `lib/researchApproval.ts` (first wave), `assess.ts` (subsequent waves) | `runId`, `chatId`, `subQuestions` — the frontend appends these to the ones already listed rather than replacing them, so an earlier wave's researchers stay on screen |
| `research_finding` | `researcher.ts`, once per sub-question | `runId`, `chatId`, `subQuestionId`, `summary`, `sourceUrls` |
| `research_assess` | `assess.ts`, every round | `runId`, `chatId`, `findingCount`, `done` |
| `research_done` | `report.ts` | `runId`, `chatId`, `msgId` |
| `research_plan_decision` | `ws/sendMessage.ts` | `runId`, `chatId`, `msgId`, `decision` (`approve\|revise`) — a composer reply answered the approval gate |
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
