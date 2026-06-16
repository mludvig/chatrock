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
- Message (turn): `PK=CHAT#<chatId>` / `SK=MSG#<iso-timestamp>#<seq>#<msgId>` — role, **blocks**, model, createdAt, **msgId**, **parentId**, **responseId**, turnIndex, usage?, thinkingEffort?, webSearch?
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
- `buildActivePath(rows, leafId)` — leaf→root walk, reversed to root→leaf order
- `resolveLeaf(rows, msgId)` — walk DOWN to the deepest descendant (last child at each level)
- `resolveResponseLeaf(rows, msgId)` — same but stays within one `responseId` group (no crossing into the next bubble)

`responseId` groups all turns of a single Bedrock call (the initial assistant text + any tool-use turns + tool-result turns). A display bubble = one `responseId` group collapsed into steps[].

**WS payload contract** (`ws/sendMessage.ts` / `api/ws.ts`):
- Normal send: `{ chatId, content, model, systemPrompt, modelSettings }` — persists user turn at current leaf, streams answer
- Re-run: `{ chatId, parentId, model, systemPrompt, modelSettings }` — no `content`; streams new sibling answer under `parentId`
- Edit: `{ chatId, parentId, content, model, systemPrompt, modelSettings }` — persists new user sibling under `parentId`, streams answer

**Display bubble shape** (from `GET /messages`): each bubble includes `msgId`, `parentId`, `siblingIndex` (1-based), `siblingCount`, `siblings` (ordered msgId array). The client uses these for sibling navigation without extra round trips.

### Backend structure

```
backend/src/
  config/models.ts        — model registry with capabilities (temperature/topP/topK/thinking/attachments)
  lib/bedrock.ts          — ConverseStream wrapper + agentic tool-use loop (MAX_TOOL_ROUNDS=8)
  lib/blocks.ts           — block-level helpers: capToolResultText (30 KB cap)
  lib/dynamo.ts           — DynamoDB access layer: buildTurnKey/buildChatKey, batchPutMessages, setStreamCancel/isStreamCancelled; project/file/memory dynamo fns
  lib/tools.ts            — Bedrock tool specs: WEB_TOOLS, MEMORY_TOOL, MANAGE_PROJECT_MEMORY_TOOL, READ_PROJECT_FILE_TOOL, READ_PROJECT_CHAT_TOOL; executeTool dispatcher; ToolContext type
  lib/tree.ts             — in-memory tree helpers: TurnRow type, buildActivePath, resolveLeaf, resolveResponseLeaf
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
| `tool_result` | `toolUseId`, `name`, `isError`, `content` |
| `delta` | `text` |
| `done` | `stopReason` |
| `cancelled` | — (stream was aborted by `cancelMessage`) |
| `usage` | `usage` (inputTokens, outputTokens, cache*) |
| `titleUpdated` | `chatId`, `title` |
| `memoryUpdated` | `count` — number of new memories extracted this turn |
| `warning` | `message` — non-fatal post-turn failure (enrichment DB write failed, etc.) |
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

`ModelSettings.webSearch` defaults to `true`; when `false`, `bedrock.ts` omits web tools from the tool list. `ModelSettings.memoryEnabled` defaults to `true`; when `false`, the `manage_memory` tool is also omitted. Per-assistant-turn `thinkingEffort` and `webSearch` are persisted in DynamoDB and surfaced in the bubble metadata line.

### Frontend env vars

Set by `deploy.sh` at build time from Terraform outputs. For local dev, copy `frontend/.deploy-env` (written after each deploy) into your shell or a `.env` file:

```
VITE_API_BASE_URL, VITE_WS_URL, VITE_COGNITO_USER_POOL_ID, VITE_COGNITO_CLIENT_ID,
VITE_COGNITO_DOMAIN, VITE_APP_URL
```

### Jina web search / fetch

`lib/tools.ts` implements `web_search` (via `s.jina.ai/{query}` with `JINA_API_KEY`) and `web_fetch` (via `r.jina.ai/{url}`, no key). The API key is set in `terraform/terraform.tfvars` as `jina_api_key` and injected into Lambda env. If empty, the tools still appear in the tool spec but requests will 401.

### Memory

Two writers, two stores (user and project):
- **`manage_memory` tool** (`lib/memory.ts` `executeMemoryTool`): model calls during agentic loop. Operations: `remember`, `update`, `forget`. `sub` from `ToolContext`. On success → `memoryUpdated` WS frame → frontend toasts + refreshes.
- **`manage_project_memory` tool** (`lib/memory.ts` `executeProjectMemoryTool`): same pattern but scoped to `ctx.projectId`. Project category enum: `decision|convention|fact|constraint|glossary|other`. Only present in the tool list when `ctx.projectId` is set.
- **Passive enrichment** (`sendMessage.ts` post-turn block, `lib/enrichment.ts`): one Haiku call (`enrichTurn`) per turn when `memoryEnabled`. Returns `{ userFacts[], projectFacts[]?, summary?, title? }` in a single JSON response. The call is parameterised: always has the user-facts section; `isProject:true` adds project-facts + summary sections; `needTitle:true` adds a title section. Post-call: `reconcile()` + `putUserMemory` for user ADDs; if project → `reconcile()` + `putProjectMemory` for project ADDs and `updateChatSummary` when `summary` present; if `title` → `updateChatTitle` + `titleUpdated` frame. Errors in the DB-write phase emit one `warning` WS frame and log `enrich_turn_error`.

`assembleSystemPrompt` (`lib/promptAssembly.ts`) injects user memory as `- [memId] text` lines, project memory in a separate "About this project:" block, and a project manifest (files + sibling chats) for project chats.

`bedrock.ts` builds the tool list via `buildToolsWithCache(settings, ctx?)`: web tools when `webSearch !== false`; memory tool when `memoryEnabled !== false`; project memory tool + two read tools when `ctx?.projectId`; cachePoint always last.

### User preferences

`lib/preferences.ts` defines `UserPreferences`: `persona` (custom instructions), `defaultModel`, `thinkingEffort`, `webSearch`, `temperature`, `topP`, `topK`, `answerLength` (`default|short|extensive`), `injectCurrentDate`, `showTokenStats`. `resolvePreferences(prefs)` merges layers (user → project → chat; project/chat layers not yet used). Stored as a JSON blob in the `prefs` attribute of the `PREF#USER` row.

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
