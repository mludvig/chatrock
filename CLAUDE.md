# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Chatrock is a multi-user LLM chat web app on AWS: React SPA + TypeScript Lambda backend + API Gateway WebSocket streaming + Cognito auth + DynamoDB + S3/CloudFront. Live at `https://chatrock.ccxdemo.dev`.

## Commands

### Deploy (the primary workflow)

```bash
./deploy.sh               # full build + deploy (backend → terraform → frontend → CF invalidation)
./deploy.sh backend       # backend Lambdas + terraform apply only
./deploy.sh frontend      # frontend build + S3 sync + CF invalidation only
./deploy.sh plan          # terraform plan (builds backend zips if stale)
./deploy.sh validate      # terraform validate only
./deploy.sh tf            # terraform apply only (zips must already exist)
```

Rebuilds are skipped automatically when sources are not newer than artifacts. Use `--force-rebuild` to override.

### Backend

```bash
npm --prefix backend run build      # bundle all Lambdas → terraform/dist/*.zip via esbuild
npm --prefix backend run typecheck  # tsc --noEmit (no emit, type-check only)
npm --prefix backend test           # jest (tests in backend/tests/**/*.test.ts)
npm --prefix backend test -- --testPathPattern=sendMessage  # run a single test file
npm --prefix backend run db:wipe    # wipe entire DynamoDB table (interactive confirm — dev only)
```

### Frontend

```bash
npm --prefix frontend run build     # tsc + vite build → frontend/dist/
npm --prefix frontend run dev       # local dev server (needs VITE_* env vars — see frontend/.deploy-env after a deploy)
```

The frontend has no test suite. Type-checking is part of `npm run build` (tsc runs first).

### E2E tests

```bash
npm run test:e2e                              # all Playwright tests against chatrock.ccxdemo.dev
npm run test:e2e -- e2e/fork-chat.spec.ts     # single spec file
npm run test:e2e:headed                       # with visible browser
```

Requires `COGNITO_USERNAME` / `COGNITO_PASSWORD` in `.env` (root). Auth state is cached in `.auth/state.json` by the setup project. Tests run against the live deployment — deploy before testing UI changes.

### Terraform

```bash
terraform -chdir=terraform init
terraform -chdir=terraform plan
terraform -chdir=terraform apply -auto-approve
```

State is local (`terraform/terraform.tfstate`). Secrets go in `terraform/terraform.tfvars` (gitignored).

## Architecture

### Request paths

```
Browser → CloudFront (single distribution, custom domain)
  /api/*  → API Gateway HTTP API  → Lambda (CRUD handlers)
  /ws     → API Gateway WebSocket → Lambda (streaming handler)
  default → S3 (SPA assets)
```

- **Auth**: Cognito Hosted UI (OIDC/PKCE). HTTP API uses a Cognito JWT authorizer. WebSocket `$connect` uses a Lambda authorizer that validates the access token from `?token=` query param (browsers can't set WebSocket headers).
- **Streaming**: client sends `{ action: 'sendMessage', chatId, content?, model, systemPrompt, modelSettings, parentId? }` over WebSocket. `ws/sendMessage.ts` persists the user message (if `content` present), calls Bedrock `ConverseStream` in an agentic loop (up to 8 rounds for tool use), pushes event frames back via `ApiGatewayManagementApi.postToConnection`. See WS payload contract in the tree model section.
- **Cancel**: client sends `{ action: 'cancelMessage' }` over WebSocket. `ws/cancelMessage.ts` sets a DynamoDB cancel flag on the `CONN#` row; the stream loop polls it every 750ms via `isStreamCancelled`, aborts the Bedrock stream via `AbortController`, flushes any partial text as a turn, then emits `cancelled`.

### DynamoDB single-table

Table `chatrock-prod` with PK/SK:
- Chat: `PK=USER#<sub>` / `SK=CHAT#<chatId>` — title, model, systemPrompt, modelSettings?, createdAt, updatedAt, **activeLeafId**, projectId?, summary?
- Message (turn): `PK=CHAT#<chatId>` / `SK=MSG#<iso-timestamp>#<seq>#<msgId>` — role, **blocks**, model, createdAt, **msgId**, **parentId**, **responseId**, turnIndex, usage?, thinkingEffort?, webSearchEnabled?
- WS connection: `PK=CONN#<connId>` / `SK=CONN#<connId>` — userSub, TTL, cancelRequested?
- User prefs: `PK=USER#<sub>` / `SK=PREF#USER` — `prefs` attribute (`UserPreferences` JSON blob), updatedAt
- Memory: `PK=USER#<sub>` / `SK=MEM#USER#<memId>` — text, category (`identity|preference|style|other`), createdAt, updatedAt
- Project: `PK=USER#<sub>` / `SK=PROJECT#<projectId>` — name, description?, instructions?, memoryEnabled?, createdAt, updatedAt
- Project memory: `PK=PROJECT#<projectId>` / `SK=MEM#<memId>` — text, category (`decision|convention|fact|constraint|glossary|other`), createdAt, updatedAt
- Project file: `PK=PROJECT#<projectId>` / `SK=FILE#<fileId>` — filename, contentType, sizeBytes, s3Key, status (`uploading|processing|ready|error`), microLabel?, summary?, extractedTextKey?, inclusion (`auto|always|never`), createdAt, updatedAt

S3 project files: `attachments/<sub>/project/<projectId>/<fileId>/<filename>`; extracted sidecar: `attachments/<sub>/project/<projectId>/<fileId>/.extracted.txt`.

Every CRUD handler derives `sub` from the JWT claims — never from client input — so users only ever touch their own partition.

`blocks` is the raw `ContentBlock[]` array from the Bedrock `ConverseStream` response, stored verbatim. It is the canonical source for replay — never synthesize from text.

Attachments are stored in S3 under `attachments/<sub>/<chatId>/<fileId>/<filename>`; blocks reference them as `s3://bucket/key` at rest and are hydrated to bytes before the Bedrock call.

### Conversation tree model

Each turn record has `msgId` (UUID) + `parentId` (null at root) forming a tree. `activeLeafId` on the chat record tracks the current branch tip. `GET /messages` does a single DynamoDB Query of the full `CHAT#<chatId>` partition, then walks the tree in memory to extract the active path and compute sibling metadata.

Key helpers in `backend/src/lib/tree.ts`:
- `buildActivePath(rows, leafId)` — leaf→root walk, reversed to root→leaf order. Falls back to `mostRecentLeaf(rows)` (not raw array order) when `leafId` doesn't resolve.
- `resolveLeaf(rows, msgId)` — walk DOWN to the deepest descendant (last child at each level)
- `resolveResponseLeaf(rows, msgId)` — same but stays within one `responseId` group (no crossing into the next bubble)
- `mostRecentLeaf(rows)` — tree-derived "what's the current leaf" with no starting point: walks down from every root, picks whichever terminal leaf has the latest `createdAt`
- `resolveSafeLeaf(rows, candidateMsgId)` — validated chokepoint for moving `activeLeafId`: confirms `candidateMsgId` exists in `rows` before resolving it down; falls back to `mostRecentLeaf` otherwise rather than ever persisting a phantom pointer. Used by the delete-branch handler (`http/chats.ts`) when re-resolving the leaf after deleting a subtree — `candidateMsgId` there is the deleted node's own `parentId`, which can itself be absent from `rows` (e.g. a turn that failed to persist for an unrelated reason earlier).

`responseId` groups all turns of a single Bedrock call (the initial assistant text + any tool-use turns + tool-result turns). A display bubble = one `responseId` group collapsed into steps[].

**Atomic tool-use round persistence**: `ws/sendMessage.ts` defers writing an assistant turn that contains `toolUse` blocks until its paired tool-result turn is also ready, then writes both via `dynamo.ts`'s `putMessagePair` (`TransactWriteCommand`, 2 items). This guarantees the durable tree never ends on a dangling `tool_use` — a failure between the two halves (size limit, throttling, etc.) leaves the *prior* complete round as the durable tip instead of a structurally-connected-but-Bedrock-invalid one. `lastTurnMsgId` only ever reflects the latest **durable** turn; a pending (not-yet-paired) turn's msgId is used solely to chain the next turn's `parentId` in memory. As defense-in-depth against any other way this shape could arise (stale data, a different bug), `bedrock.ts`'s `healDanglingToolUse` synthesizes a placeholder error `toolResult` for a tail assistant message with unresolved `toolUse` blocks, right alongside `coalesceMessages` (which handles the sibling failure mode: two consecutive same-role turns from an interrupted loop) — both run unconditionally before every Bedrock call.

`batchPutMessages`/`batchDeleteMessages` (fork-copy, subtree-delete) retry `BatchWriteCommand`'s `UnprocessedItems` (not atomic by default) and throw if items remain unprocessed after retries, rather than silently leaving a partial result.

**WS payload contract** (`ws/sendMessage.ts` / `api/ws.ts`):
- Normal send: `{ chatId, content, model, systemPrompt, modelSettings }` — persists user turn at current leaf, streams answer
- Re-run: `{ chatId, parentId, model, systemPrompt, modelSettings }` — no `content`; streams new sibling answer under `parentId`
- Edit: `{ chatId, parentId, content, model, systemPrompt, modelSettings }` — persists new user sibling under `parentId`, streams answer

**Display bubble shape** (from `GET /messages`): each bubble includes `msgId`, `parentId`, `siblingIndex` (1-based), `siblingCount`, `siblings` (ordered msgId array). The client uses these for sibling navigation without extra round trips.

### Backend structure

```
backend/src/
  config/models.ts        — model registry with capabilities (temperature/topP/topK/thinking/attachments)
  lib/bedrock.ts          — ConverseStream wrapper + agentic tool-use loop (MAX_TOOL_ROUNDS=8); coalesceMessages + healDanglingToolUse sanitize replayed history before every call
  lib/blocks.ts           — block-level helpers: capToolResultText (byte-accurate, default 30 KB cap, accepts a custom budget); TOOL_RESULTS_ROUND_CAP (300 KB aggregate per round)
  lib/dynamo.ts           — DynamoDB access layer: buildTurnKey/buildChatKey, putMessagePair (TransactWriteCommand, atomic 2-item write), batchPutMessages/batchDeleteMessages (retry UnprocessedItems), setStreamCancel/isStreamCancelled; project/file/memory dynamo fns
  lib/tools.ts            — Bedrock tool specs: WEB_TOOLS, TAKE_SCREENSHOT_TOOL, GET_RENDERED_PAGE_TOOL, BROWSER_TOOL, MEMORY_TOOL, MANAGE_PROJECT_MEMORY_TOOL, READ_PROJECT_FILE_TOOL, READ_PROJECT_CHAT_TOOL; executeTool dispatcher (web_search routes to Jina or AgentCore per ToolContext.webSearchProvider); ToolContext type
  lib/agentcore/gateway.ts — minimal SigV4-signed MCP client for AgentCore Gateway targets (callGatewayTool); backs agentcoreSearch today, a generic seam for future AgentCore primitives (e.g. Code Interpreter)
  lib/agentcore/browser.ts — AgentCore Browser session executor (runBrowserSteps): StartBrowserSession -> SigV4-signed CDP WebSocket -> drives an embedded `@playwright/mcp` server -> StopBrowserSession, one session per call, no state held across agentic rounds; backs take_screenshot/get_rendered_page/browse_web — see "Browser tools" below
  lib/tree.ts             — in-memory tree helpers: TurnRow type, buildActivePath, resolveLeaf, resolveResponseLeaf, mostRecentLeaf, resolveSafeLeaf
  lib/memory.ts           — manage_memory + manage_project_memory executors (remember/update/forget); reconcile() ADD-only dedup
  lib/enrichment.ts       — unified post-turn Haiku call: enrichTurn() returns userFacts + projectFacts + summary + title in one JSON call; enrichChatForProject() summary-only wrapper
  lib/attachments.ts      — S3 presigned PUT, CloudFront signed display URLs (SSM key), hydrateBlocks, copyChatObjects/rewriteBlockUri for fork; deleteProjectObjects
  lib/projectFiles.ts     — summarizeFile(): sends file to Bedrock (text/PDF/image) to produce microLabel + summary; stores extracted text sidecar for PDFs
  lib/projectContext.ts   — executeProjectReadFileTool / executeProjectReadChatTool: ownership validation, progressive detail (summary vs full), capToolResultText applied
  lib/promptAssembly.ts   — assembleSystemPrompt: merges instructions + date + answer-length + user memory + project memory + project manifest + forced files
  lib/preferences.ts      — UserPreferences type + resolvePreferences() layering
  http/chats.ts           — chat CRUD, retitle, fork, branch delete, attachment presign; PATCH accepts projectId for project membership
  http/messages.ts        — GET /messages: tree walk + attachment URL signing
  http/models.ts          — GET /models
  http/memory.ts          — GET /memory, DELETE /memory/{memId}
  http/preferences.ts     — GET /preferences, PUT /preferences
  http/projects.ts        — project CRUD + project memory + project file routes (single Lambda dispatching on routeKey)
  ws/sendMessage.ts       — the core streaming handler (the most complex file)
  ws/cancelMessage.ts     — sets DynamoDB cancel flag; stream loop polls and aborts via AbortController
  ws/authorizer.ts        — WebSocket Lambda authorizer
```

Each Lambda is bundled independently by esbuild into `terraform/dist/<name>.zip`.

### Model capabilities

`backend/src/config/models.ts` is the single source of truth. Each `Model` entry declares `capabilities: { temperature, topP, topK, thinking }`. The `thinking` field is `'adaptive'` (Opus 4.8, Sonnet 4.6 — uses `thinking.type=adaptive` + `output_config.effort`) or `'none'` (Haiku 4.5). Adding a new model is one entry in the `MODELS` array.

`bedrock.ts` calls `getCapabilities(modelId)` to build `inferenceConfig` + `additionalModelRequestFields` — temperature/topP are suppressed when thinking is active (Bedrock API requirement).

### WebSocket event protocol

The server pushes JSON frames; the frontend `api/ws.ts` routes them to the Zustand store:

| `type` | payload |
|--------|---------|
| `thinking_delta` | `text` |
| `thinking_done` | — |
| `tool_call_start` | `toolUseId`, `name` — fires immediately at block start for fast UI feedback |
| `tool_call` | `toolUseId`, `name`, `input` — fires when full input JSON is accumulated |
| `tool_result` | `toolUseId`, `name`, `isError`, `content`, `screenshotUrls?` — `screenshotUrls` is a first-class array of signed CloudFront URLs for browser-tool screenshots, never embedded as JSON inside `content` |
| `delta` | `text` |
| `done` | `stopReason` |
| `cancelled` | — (stream was aborted by `cancelMessage`) |
| `usage` | `usage` (inputTokens, outputTokens, cache*) |
| `titleUpdated` | `chatId`, `title` |
| `memoryUpdated` | `count` — number of new memories extracted this turn |
| `warning` | `message` — non-fatal post-turn failure (enrichment DB write failed, etc.) |
| `heartbeat` | — sent every `HEARTBEAT_INTERVAL_MS` (4s) while a single tool call is still in flight, so the WS connection carries real traffic during an otherwise-silent gap (observed empirically to prevent the connection going stale during slow tool calls like `browse_web`) |
| `error` | `message` |

### Frontend structure

**Layout**: CSS grid (`display: grid`, columns `48px var(--sidebar-w, 260px) 1fr`, rows `45px 1fr`). Variables: `$activity-bar-w: 48px`, `$header-h: 45px`, `$sidebar-w: 260px`. The global header spans both LHS columns (`grid-column: 1 / 3`). Sidebar width is resizable (drag `.sidebar-resizer`, clamped 180–480 px). Mobile (`max-width: 720px`) switches to `display: flex; flex-direction: column` and the activity bar + sidebar become a fixed slide-in drawer toggled by `.sidebar-open`.

```
frontend/src/
  api/http.ts             — REST client; types: Model/ModelCapabilities/ModelSettings/UserPreferences/UserMemory/Project/ProjectMemory/ProjectFile; migrateSettings(); requestUpload/uploadToS3; project + file API methods
  api/ws.ts               — WebSocket client (connect/send/cancelMessage/event routing); routes 'warning' frame → error toast
  store/chatStore.ts      — Zustand store; persists lastModel, sidebarWidth, activePanel, userPreferences; projects[] slice
  lib/toolResults.ts      — shared helper: parses web_search JSON into SearchResult[] for cards
  lib/useAsyncAction.ts   — hook: wraps async fn → {run, pending}; errors auto-push to toast store
  components/
    App.tsx                — root layout: global header (brand + new-chat btn), ActivityBar, Sidebar, ChatView; routes /p/:projectId → ProjectView
    ActivityBar.tsx        — 48 px icon rail; four panel-switch buttons (Chats/Projects/Memory/Preferences) + sign-out
    Sidebar.tsx            — thin container; renders ChatsPanel | ProjectsPanel | MemoryPanel | PreferencesPanel per activePanel
    ChatsPanel.tsx         — chat list: navigate, rename, delete, AI retitle; per-item project chip + move-to-project dropdown
    ProjectsPanel.tsx      — project list: create (inline), rename, delete; click → /p/:projectId
    ProjectView.tsx        — project detail (/p/:projectId): chats list (with summary), file upload/inclusion/delete, project memory, rename; 'New chat' creates chat in project
    MemoryPanel.tsx        — user memories grouped by category; delete; refreshes on memoryRefreshTick
    PreferencesPanel.tsx   — two tabs: Defaults (UserPreferences, 800ms debounce) and This chat (per-chat system prompt + ModelSettings)
    ChatView.tsx           — main chat pane, URL-driven (/c/new or /c/:chatId); project chip in header when chat belongs to a project
    ModelSettingsPanel.tsx — dynamic settings panel (temperature, topP, thinking effort, web search toggle, memory toggle)
    MessageBubble.tsx      — markdown + syntax-highlighted code blocks (PrismLight) with copy button; thinking, tool pills, per-message metadata; sibling nav, re-run, edit, fork, copy, delete actions
    Toaster.tsx            — stacked toast notifications (bottom-center), auto-dismiss 3s
  env.ts                  — VITE_* env var access
```

React Router v6: `/` → `/c/new`, `/c/:chatId` for chats, `/p/:projectId` for project views. Navigation is URL-driven — `useParams` replaces a global active-chat store entry.

Persisted Zustand state (localStorage via `persist` middleware): `lastModel`, `sidebarWidth`, `activePanel`, `userPreferences`. Everything else is ephemeral.

`ModelSettings.webSearchEnabled` defaults to `true`; when `false`, `bedrock.ts` omits web tools from the tool list. `ModelSettings.webSearchProvider` (`'jina' | 'agentcore'`, default `jina`) selects which backend powers the `web_search` tool — see "Web search providers" below. `ModelSettings.browserCoreEnabled` (default `true`) gates `take_screenshot`/`get_rendered_page`; `ModelSettings.browserExtendedEnabled` (default `false`) gates the scripted `browse_web` tool — see "Browser tools" below. `ModelSettings.memoryEnabled` defaults to `true`; when `false`, the `manage_memory` tool is also omitted. Per-assistant-turn `thinkingEffort` and `webSearchEnabled` are persisted in DynamoDB and surfaced in the bubble metadata line.

### Frontend env vars

Set by `deploy.sh` at build time from Terraform outputs. For local dev, copy `frontend/.deploy-env` (written after each deploy) into your shell or a `.env` file:

```
VITE_API_BASE_URL, VITE_WS_URL, VITE_COGNITO_USER_POOL_ID, VITE_COGNITO_CLIENT_ID,
VITE_COGNITO_DOMAIN, VITE_APP_URL
```

### Web search providers

`lib/tools.ts` implements `web_search` against two interchangeable backends, selected per-call by `ToolContext.webSearchProvider` (threaded from `ModelSettings.webSearchProvider` via `sendMessage.ts`'s preference resolution — same layering as every other model setting). Both map into the identical `{ results: [{title,url,description}], text }` JSON contract so `lib/toolResults.ts` card parsing on the frontend is provider-agnostic. `web_fetch` always uses Jina — AgentCore Web Search has no page-fetch primitive, only ranked snippets.
- **Jina** (default): `jinaSearch`/`jinaFetch` call `s.jina.ai/{query}` / `r.jina.ai/{url}` with `JINA_API_KEY` (terraform var `jina_api_key`, optional — empty key still appears in the tool spec but requests 401).
- **Amazon Bedrock AgentCore Web Search**: `agentcoreSearch` calls `callGatewayTool('WebSearch', { query, maxResults })` in `lib/agentcore/gateway.ts`, a minimal MCP (Model Context Protocol) client that SigV4-signs requests to an AgentCore Gateway (inbound auth type `AWS_IAM` — the Lambda's own execution role signs directly, no OAuth/Cognito machine-to-machine flow). Web Search is `us-east-1`-only as of June 2026, so the gateway is region-pinned there regardless of the app's home region (`terraform/agentcore.tf`); env vars `AGENTCORE_GATEWAY_URL` / `AGENTCORE_REGION` carry the endpoint into every Lambda. `lib/agentcore/` is structured as a general seam — a future AgentCore Code Interpreter integration would add a sibling file reusing `callGatewayTool` unchanged. Each successful call logs a `web_search` CloudWatch event with `provider`.
- **Provider's Gateway *target*** (the Web Search connector itself) is a one-time manual `aws bedrock-agentcore-control create-gateway-target` step, not a Terraform resource — see the comment block in `terraform/agentcore.tf` for why (the AWS provider's `aws_bedrockagentcore_gateway_target` doesn't yet expose the `connector` target type) and the exact command.

### Browser tools

Backed by Amazon Bedrock AgentCore Browser — architecturally unlike Web Search (no Gateway/MCP
target): `lib/agentcore/browser.ts`'s `runBrowserSteps()` does `StartBrowserSession` against the
AWS-managed system browser (`aws.browser.v1`, literal `aws` pseudo-account, pre-exists in every
region) → SigV4-signs a CDP WebSocket-upgrade GET (mirrors `gateway.ts`'s signer, applied to a
GET instead of a POST) → hands the endpoint to an **embedded** `@playwright/mcp` server
(`createConnection({ browser: { cdpEndpoint, cdpHeaders } })`, restricted to the
`core`/`core-navigation`/`core-input`/`core-tabs` capability groups) → drives it with an
in-process MCP `Client` over `InMemoryTransport.createLinkedPair()` → runs each step via
`callTool` → `StopBrowserSession` in a `finally`. One session per call, opened and torn down
entirely inside `executeTool()` — no session state is ever held across agentic rounds in
`sendMessage.ts` (deliberately: avoids the cross-call-state fragility class hardened in
`fa70b25`). `@playwright/mcp`/`playwright-core`/`playwright`/`chromium-bidi` are esbuild
`external` and their real `node_modules` trees are packaged only inside `ws-sendMessage.zip`
(see `backend/esbuild.config.mjs`) — `agentcore/browser.ts` is only ever imported there via a
lazy `await import(...)` inside each browser-tool executor, so no other Lambda eagerly resolves it.

Three Bedrock tools share this executor, split into two preference-gated groups:
- **Core** (`ModelSettings.browserCoreEnabled`, default `true`): `take_screenshot` (`url`,
  `fullPage?`, `width?`, `height?`, `format?`) and `get_rendered_page` (`url`, `width?`,
  `height?` — a JS-rendered accessibility-tree snapshot, the dynamic-page counterpart to
  `web_fetch`'s static fetch). Each takes one URL per call and lowers to a fixed 2–3 step
  `BrowserStep[]` (optional `browser_resize` + `browser_navigate` + `browser_take_screenshot`/
  `browser_snapshot`) — covers the common case without the model building a `steps` array.
- **Extended** (`ModelSettings.browserExtendedEnabled`, default `false`): `browse_web` accepts an
  arbitrary ordered `steps: [{tool, params}]` list (max `MAX_BROWSER_STEPS`=15,
  `MAX_BROWSER_SCREENSHOTS`=4 per call) from a curated allowlist (`ALLOWED_BROWSER_TOOLS` in
  `tools.ts`) of the real `@playwright/mcp` tool catalogue — for multi-step interactions (click,
  type, navigate between pages, wait, fill forms) that the Core shortcuts don't cover. Off by
  default because it's the more expensive/scriptable surface.

A call's `content[]` can carry multiple text entries (e.g. a snapshot block *and* a console-log
block) and/or multiple images — `tools.ts`'s shared `browserResultsToContent()` aggregates both
per step. Image entries flow through the same live/persist bifurcation `bedrock.ts` already uses
for any image-bearing tool result: uploaded to S3 via `putObjectBytes` under the chat's
attachment prefix, with `screenshotUrls` (signed CloudFront URLs) carried as a **first-class**
`StreamChunk`/WS-frame/`ToolStep` field — never JSON-embedded inside the text `content`, so
neither the live WS handler nor `GET /messages` ever has to re-parse an envelope out of a string.
The frontend renders `screenshotUrls` as clickable thumbnails (open full-size in a new tab) above
the text trace in the tool-call pill.

Validation errors (empty/missing `steps`, an unknown step `tool` name, too many steps/screenshots)
and the dispatcher's catch-all for an unknown top-level tool name are written to be
self-correcting: if the model calls a `browse_web` step name (e.g. `browser_take_screenshot`) as
if it were its own tool, the error explicitly says to nest it inside `browse_web`'s `steps` array
or use `take_screenshot`/`get_rendered_page` instead, rather than a bare "unknown tool".

### Memory

Two writers, two stores (user and project):
- **`manage_memory` tool** (`lib/memory.ts` `executeMemoryTool`): model calls during agentic loop. Operations: `remember`, `update`, `forget`. `sub` from `ToolContext`. On success → `memoryUpdated` WS frame → frontend toasts + refreshes.
- **`manage_project_memory` tool** (`lib/memory.ts` `executeProjectMemoryTool`): same pattern but scoped to `ctx.projectId`. Project category enum: `decision|convention|fact|constraint|glossary|other`. Only present in the tool list when `ctx.projectId` is set.
- **Passive enrichment** (`sendMessage.ts` post-turn block, `lib/enrichment.ts`): one Haiku call (`enrichTurn`) per turn when `memoryEnabled`. Returns `{ userFacts[], projectFacts[]?, summary?, title? }` in a single JSON response. The call is parameterised: always has the user-facts section; `isProject:true` adds project-facts + summary sections; `needTitle:true` adds a title section. Post-call: `reconcile()` + `putUserMemory` for user ADDs; if project → `reconcile()` + `putProjectMemory` for project ADDs and `updateChatSummary` when `summary` present; if `title` → `updateChatTitle` + `titleUpdated` frame. Errors in the DB-write phase emit one `warning` WS frame and log `enrich_turn_error`.

`assembleSystemPrompt` (`lib/promptAssembly.ts`) injects user memory as `- [memId] text` lines, project memory in a separate "About this project:" block, and a project manifest (files + sibling chats) for project chats.

`bedrock.ts` builds the tool list via `buildToolsWithCache(settings, ctx?)`: web tools when `webSearchEnabled !== false`; Core browser tools (`take_screenshot`, `get_rendered_page`) when `browserCoreEnabled !== false`; `browse_web` when `browserExtendedEnabled === true`; memory tool when `memoryEnabled !== false`; project memory tool + two read tools when `ctx?.projectId`; cachePoint always last. Which provider backs `web_search` (Jina vs. AgentCore) doesn't affect the tool spec — see "Web search providers".

### User preferences

`lib/preferences.ts` defines `UserPreferences`: `persona` (custom instructions), `defaultModel`, `thinkingEffort`, `webSearchEnabled`, `webSearchProvider` (`'jina'|'agentcore'`), `browserCoreEnabled`, `browserExtendedEnabled`, `temperature`, `topP`, `topK`, `answerLength` (`default|short|extensive`), `injectCurrentDate`, `showTokenStats`. `resolvePreferences(prefs)` merges layers (user → project → chat; project/chat layers not yet used). Stored as a JSON blob in the `prefs` attribute of the `PREF#USER` row.

`http/preferences.ts` handles `GET /api/preferences` and `PUT /api/preferences`.

### Attachments

`lib/attachments.ts` handles the full attachment lifecycle:
- **Validate**: `validateAttachment(contentType, sizeBytes)` — allowlist: images (png/jpeg/gif/webp ≤5 MB), pdf (≤25 MB), text/csv/md/octet-stream (≤1 MB).
- **Upload**: `POST /api/attachments` (in `http/chats.ts`) returns `{s3Key, uploadUrl}` (S3 presigned PUT, 15-min expiry). Client uploads directly to S3.
- **Display**: `signCloudFrontUrl(s3Key)` issues a signed CloudFront URL (1-hour expiry) using an RSA private key loaded from SSM. Called by `GET /messages` to hydrate `attachmentUrl` on each block before returning to the client.
- **Inference**: `hydrateBlocks(blocks)` fetches bytes from S3 for image/document blocks before the Bedrock call (blocks carry `s3://bucket/key` at rest).
- **Fork**: `copyChatObjects(sub, srcChatId, dstChatId)` copies S3 objects; `rewriteBlockUri(block, keyMap)` patches the copied blocks to point at the new keys.

### HTTP API routes

| Route | Handler |
|-------|---------|
| `GET /api/chats` | list chats (includes `projectId?`) |
| `POST /api/chats` | create chat (accepts optional `projectId`) |
| `PATCH /api/chats/{chatId}` | update title / systemPrompt / model / activeLeafId / modelSettings / **projectId** |
| `DELETE /api/chats/{chatId}` | delete chat + S3 objects |
| `POST /api/chats/{chatId}/retitle` | AI-generated title via `converseOnce` |
| `POST /api/chats/{chatId}/fork` | clone active-path into new chat (carries `projectId`) |
| `DELETE /api/chats/{chatId}/messages/{msgId}` | delete message subtree |
| `GET /api/chats/{chatId}/messages` | full tree walk + attachment URL signing |
| `POST /api/attachments` | presign S3 PUT → `{s3Key, uploadUrl}` |
| `GET /api/models` | list models |
| `GET /api/memory` | list user memories |
| `DELETE /api/memory/{memId}` | delete a memory |
| `GET /api/preferences` | get `UserPreferences` |
| `PUT /api/preferences` | save `UserPreferences` |
| `GET /api/projects` | list projects |
| `POST /api/projects` | create project |
| `GET /api/projects/{projectId}` | get project + member chats |
| `PATCH /api/projects/{projectId}` | update project fields |
| `DELETE /api/projects/{projectId}` | delete project (un-assigns chats, removes memory/files/S3) |
| `GET /api/projects/{projectId}/memory` | list project memories |
| `DELETE /api/projects/{projectId}/memory/{memId}` | delete a project memory |
| `GET /api/projects/{projectId}/files` | list project files |
| `POST /api/projects/{projectId}/files` | request file upload → `{fileId, s3Key, uploadUrl}` |
| `PUT /api/projects/{projectId}/files/{fileId}` | finalize/process file → generates microLabel + summary |
| `PATCH /api/projects/{projectId}/files/{fileId}` | update inclusion mode (`auto|always|never`) |
| `DELETE /api/projects/{projectId}/files/{fileId}` | delete file + S3 objects |

### CloudWatch logging

All LLM calls emit single-line `JSON.stringify({event, ...})` records to stdout (→ CloudWatch):

| `event` | Where | Key fields |
|---------|-------|-----------|
| `llm_call` purpose=`chat` | `sendMessage.ts` on stop | model, chatId, stopReason, inputTokens, outputTokens, cacheRead/WriteInputTokens |
| `llm_call` purpose=`enrich_turn` | `sendMessage.ts` post-turn | model, chatId, userAdded, projectAdded, hasSummary, hasTitle |
| `llm_call` purpose=`file_summary` | `http/projects.ts` finalize | model, projectId, fileId, filename |
| `memory_tool` | `memory.ts` per call | op (remember/update/forget), scope (user/project), result |
| `web_search` | `tools.ts` per call | provider (jina/agentcore), result |
| `browser_tool` | `tools.ts` per call | tool (take_screenshot/get_rendered_page/browse_web), result, stepCount?, screenshotCount, chatId |
| `stream_start` / `stream_error` / `stream_cancelled` | `sendMessage.ts` | — |
| `enrich_turn_error` | `sendMessage.ts` post-turn | chatId, error |
| `manifest_truncated` | `sendMessage.ts` manifest build | kind (files/chats), total, kept, projectId, chatId |
| `forced_files_truncated` | `sendMessage.ts` forced files build | skipped, totalKept, projectId, chatId |
| `chat_created/updated/deleted/forked`, `branch_deleted` | `http/chats.ts` | — |

### Projects

Projects group related chats + files and give the model project-scoped memory and context via **progressive disclosure**:

- **L0 manifest** (always): system prompt includes a compact list of `[fileId] name — micro-label` and `[chatId] title — summary-snippet` for all non-`never` files and sibling chats (capped at 50 files / 30 chats). Navigational only — model told not to draw conclusions from labels.
- **L1 summary** (on-demand): `read_project_file` / `read_project_chat` with `detail:'summary'` returns the pre-computed summary.
- **L2 full** (on-demand): `detail:'full'` returns decoded text (capped via `capToolResultText`), image bytes, or full transcript.
- **Forced inclusion**: files with `inclusion:'always'` have their content fetched from S3 and injected directly into the system prompt (per-file cap 20 KB, total cap 80 KB). Files with `inclusion:'never'` are excluded from the manifest entirely.
- **Chat summaries**: `chat.summary` is refreshed post-turn via `enrichTurn` (the same single Haiku call that extracts user/project facts). `enrichChatForProject()` runs immediately when a chat is moved into a project.
- **File processing**: on finalize (`PUT …/files/{id}`), `summarizeFile()` sends the file to Bedrock to produce `microLabel` + `summary`. PDFs also get an extracted-text sidecar at `.extracted.txt`. Status: `uploading → processing → ready / error`.
- **Ownership**: all tool executors (`executeProjectReadFileTool`, `executeProjectReadChatTool`, `executeProjectMemoryTool`) validate `ctx.projectId` — never trust model-supplied ids.
- **Membership**: moving a chat is a single `projectId` attribute write on the `CHAT#` row — no re-keying of messages.

## Key gotchas

- **Inference profiles**: models use `global.*` cross-region inference profiles (`global.anthropic.claude-opus-4-8` etc.), not direct model IDs. Verify with `aws bedrock list-inference-profiles --region ap-southeast-2 --type-equals SYSTEM_DEFINED`.
- **Thinking API**: adaptive thinking (`type=adaptive` + `output_config.effort`) is what Opus 4.8 and Sonnet 4.6 expect — not `type=enabled`/`budget_tokens`. Temperature/topP must be absent when thinking is active.
- **WS authorizer**: TTL caching (`authorizer_result_ttl_in_seconds`) is not valid for WebSocket APIs — omit it.
- **`cd` in Bash**: avoid `cd` in commands; use `--prefix` or absolute paths to keep auto-approval working.
- **Screenshots**: save to `.screenshots/YYYY-MM-DD-description.jpg`.
- **AgentCore Gateway target type**: `aws_bedrockagentcore_gateway_target` (AWS provider v6.51.0) doesn't yet support the `connector` target type that Web Search needs — only the *gateway* is a real Terraform resource (`terraform/agentcore.tf`); the target is a one-time manual `aws bedrock-agentcore-control create-gateway-target` step (comment in that file has the exact command). Needs AWS CLI ≥ 2.35.7 — older builds reject the `connector` parameter outright.
- **AgentCore Browser IAM ARN**: the AWS-managed system browser lives under the literal `aws` pseudo-account, not the caller's own account — the IAM resource must be `arn:aws:bedrock-agentcore:<region>:aws:browser/aws.browser.v1` (same pattern as Web Search's `arn:...:aws:tool/web-search.v1`). Scoping it to the caller's account ID instead produces an opaque `AccessDeniedException` on `StartBrowserSession`.
