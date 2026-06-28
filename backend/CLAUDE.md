# Backend

See root `CLAUDE.md` for commands, architecture overview, DynamoDB schema, and key gotchas.

## Backend structure

```
backend/src/
  config/models.ts        — model registry with capabilities (temperature/topP/topK/thinking/attachments)
  lib/bedrock.ts          — ConverseStream wrapper + agentic tool-use loop (MAX_TOOL_ROUNDS=8); coalesceMessages + healDanglingToolUse sanitize replayed history before every call
  lib/blocks.ts           — block-level helpers: capToolResultText (byte-accurate, default 30 KB cap, accepts a custom budget); TOOL_RESULTS_ROUND_CAP (300 KB aggregate per round)
  lib/dynamo.ts           — DynamoDB access layer: buildTurnKey/buildChatKey, putMessagePair (TransactWriteCommand, atomic 2-item write), batchPutMessages/batchDeleteMessages (retry UnprocessedItems), setStreamCancel/isStreamCancelled; project/file/memory dynamo fns
  lib/tools.ts            — Bedrock tool specs: WEB_TOOLS, TAKE_SCREENSHOT_TOOL, GET_RENDERED_PAGE_TOOL, BROWSER_TOOL, MEMORY_TOOL, MANAGE_PROJECT_MEMORY_TOOL, READ_PROJECT_FILE_TOOL, READ_PROJECT_CHAT_TOOL, SEARCH_HISTORY_TOOL; executeTool dispatcher (web_search routes to Jina or AgentCore per ToolContext.webSearchProvider; search_history dispatches to lib/search.ts); ToolContext type (incl. searchScope)
  lib/search.ts           — the "Search" retrieval seam: searchHistory() ranks a corpus of chat/file summaries against a query (Haiku, JSON); buildSearchHistoryCorpus() assembles that corpus (project- or global-scoped, chats + project files); executeSearchHistoryTool() is the search_history tool executor
  lib/agentcore/gateway.ts — minimal SigV4-signed MCP client for AgentCore Gateway targets (callGatewayTool); backs agentcoreSearch today, a generic seam for future AgentCore primitives (e.g. Code Interpreter)
  lib/agentcore/browser.ts — AgentCore Browser session executor (runBrowserSteps): StartBrowserSession -> SigV4-signed CDP WebSocket -> drives an embedded @playwright/mcp server -> StopBrowserSession, one session per call, no state held across agentic rounds
  lib/tree.ts             — in-memory tree helpers: TurnRow type, buildActivePath, resolveLeaf, resolveResponseLeaf, mostRecentLeaf, resolveSafeLeaf
  lib/memory.ts           — manage_memory + manage_project_memory executors (remember/update/forget); reconcile() ADD-only dedup
  lib/enrichment.ts       — post-turn extraction: enrichUserFacts() (Sonnet), enrichProjectFacts() (Sonnet), summarizeChat() (Sonnet), generateChatTitle() (Haiku); all independent calls, each logs on failure
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

## Model capabilities

`backend/src/config/models.ts` is the single source of truth. Each `Model` entry declares `capabilities: { temperature, topP, topK, thinking }`. The `thinking` field is `'adaptive'` (Opus 4.8, Sonnet 4.6 — uses `thinking.type=adaptive` + `output_config.effort`) or `'none'` (Haiku 4.5). Adding a new model is one entry in the `MODELS` array.

`bedrock.ts` calls `getCapabilities(modelId)` to build `inferenceConfig` + `additionalModelRequestFields` — temperature/topP are suppressed when thinking is active (Bedrock API requirement).

## Conversation tree internals

**Atomic tool-use round persistence**: `ws/sendMessage.ts` defers writing an assistant turn that contains `toolUse` blocks until its paired tool-result turn is also ready, then writes both via `dynamo.ts`'s `putMessagePair` (`TransactWriteCommand`, 2 items). This guarantees the durable tree never ends on a dangling `tool_use`. `lastTurnMsgId` only ever reflects the latest **durable** turn; a pending (not-yet-paired) turn's msgId is used solely to chain the next turn's `parentId` in memory. As defense-in-depth, `bedrock.ts`'s `healDanglingToolUse` synthesizes a placeholder error `toolResult` for a tail assistant message with unresolved `toolUse` blocks, right alongside `coalesceMessages` (which handles two consecutive same-role turns from an interrupted loop) — both run unconditionally before every Bedrock call.

`batchPutMessages`/`batchDeleteMessages` (fork-copy, subtree-delete) retry `BatchWriteCommand`'s `UnprocessedItems` and throw if items remain unprocessed after retries, rather than silently leaving a partial result.

## Web search providers

`lib/tools.ts` implements `web_search` against two interchangeable backends, selected per-call by `ToolContext.webSearchProvider`. Both map into the identical `{ results: [{title,url,description}], text }` JSON contract. `web_fetch` always uses Jina.
- **Jina** (default): `jinaSearch`/`jinaFetch` call `s.jina.ai/{query}` / `r.jina.ai/{url}` with `JINA_API_KEY` (terraform var `jina_api_key`, optional).
- **Amazon Bedrock AgentCore Web Search**: `agentcoreSearch` calls `callGatewayTool('WebSearch', { query, maxResults })` in `lib/agentcore/gateway.ts`, a minimal MCP client that SigV4-signs requests to an AgentCore Gateway. Web Search is `us-east-1`-only as of June 2026 (`terraform/agentcore.tf`); env vars `AGENTCORE_GATEWAY_URL` / `AGENTCORE_REGION` carry the endpoint.
- **Provider's Gateway target** (the Web Search connector itself) is a one-time manual `aws bedrock-agentcore-control create-gateway-target` step, not a Terraform resource — see the comment block in `terraform/agentcore.tf` for the exact command. Needs AWS CLI ≥ 2.35.7.

## Browser tools

Backed by Amazon Bedrock AgentCore Browser: `lib/agentcore/browser.ts`'s `runBrowserSteps()` does `StartBrowserSession` against the AWS-managed system browser (`aws.browser.v1`, literal `aws` pseudo-account) → SigV4-signs a CDP WebSocket-upgrade GET → hands the endpoint to an **embedded** `@playwright/mcp` server (restricted to `core`/`core-navigation`/`core-input`/`core-tabs` capability groups) → drives it with an in-process MCP `Client` over `InMemoryTransport.createLinkedPair()` → `StopBrowserSession` in a `finally`. One session per call, no session state held across agentic rounds.

`@playwright/mcp`/`playwright-core`/`playwright`/`chromium-bidi` are esbuild `external` and their real `node_modules` trees are packaged only inside `ws-sendMessage.zip` — `agentcore/browser.ts` is only ever imported via a lazy `await import(...)` inside each browser-tool executor.

Three Bedrock tools share this executor:
- **Core** (`ModelSettings.browserCoreEnabled`, default `true`): `take_screenshot` and `get_rendered_page` — each takes one URL per call and lowers to a fixed 2–3 step `BrowserStep[]`.
- **Extended** (`ModelSettings.browserExtendedEnabled`, default `false`): `browse_web` accepts an arbitrary ordered `steps: [{tool, params}]` list (max `MAX_BROWSER_STEPS`=15, `MAX_BROWSER_SCREENSHOTS`=4 per call) from a curated allowlist (`ALLOWED_BROWSER_TOOLS` in `tools.ts`) of the real `@playwright/mcp` tool catalogue.

Screenshot images flow through the same live/persist bifurcation `bedrock.ts` uses for any image-bearing tool result: uploaded to S3, with `screenshotUrls` (signed CloudFront URLs) carried as a first-class `StreamChunk`/WS-frame/`ToolStep` field — never JSON-embedded inside text content.

## Search history

The user-facing feature is called **"Search"** (header search box). Every identifier uses the literal words `search`/`search_history`, never "find". A deliberate **retrieval seam** — today it's LLM ranking of stored summaries; the same `search_history` tool / `searchHistory()` interface is where a future hybrid retriever plugs in.

- **`search_history` tool** (`lib/tools.ts` `SEARCH_HISTORY_TOOL` spec, `lib/search.ts`): input `{ query, scope?: 'project'|'global' }`. `'project'` always resolves to `ctx.projectId` (never a model-supplied id). Gated by `ModelSettings.searchEnabled` (default `true`).
- **Corpus** (`buildSearchHistoryCorpus`): chats with a non-empty `summary` plus, for project scope, that project's ready files; for global scope, a capped sweep (`SEARCH_HISTORY_PROJECT_SWEEP_CAP`=20 projects) of all user's projects' files. Capped at `SEARCH_HISTORY_CORPUS_CAP`=200 items.
- **Ranking** (`searchHistory(corpus, query)`): one Haiku call returning `{"results":[{"id":"<kind>:<id>","reason":"..."}]}` — an **object wrapper, not a bare array** (reuses `enrichment.ts`'s `safeParse` which rejects non-objects). Hallucinated ids not in the corpus are dropped.
- **Explicit Search entry point** (header search box): creates a new chat and issues the first WS send with `search: { scope }` set. `sendMessage.ts` threads this into `ToolContext.searchScope` and into `converseStream`'s `forceToolName` param, setting Bedrock `toolChoice: { tool: { name: 'search_history' } }` on round 0 only. Forcing `toolChoice` requires thinking off for that round.
- **Cards** (`MessageBubble.tsx` `SearchHistoryResultCard`): a chat result links to `/c/:chatId`, a file result links to `/p/:projectId`. Tool-call pill label is "Search history: …".

## Memory

Two writers, two stores (user and project):
- **`manage_memory` tool** (`lib/memory.ts`): model calls during agentic loop. Operations: `remember`, `update`, `forget`. On success → `memoryUpdated` WS frame.
- **`manage_project_memory` tool**: same pattern but scoped to `ctx.projectId`. Only present when `ctx.projectId` is set.
- **Passive enrichment** (`sendMessage.ts` post-turn, `lib/enrichment.ts`): runs per turn when `memoryEnabled`. **The `existing` lists it reconciles against are re-read fresh AFTER the agentic loop** — not the pre-loop snapshots used for the system prompt. This is load-bearing: the model may have written via `manage_memory` mid-loop, and passive enrichment must see those writes to merge rather than re-derive duplicates.

`enrichUserFacts()` (Sonnet) always runs; `summarizeChat()` (Sonnet) also always runs, merging the latest exchange into the chat's running summary + `topics[]`. When the chat belongs to a project, `enrichProjectFacts()` (Sonnet) additionally runs. Title generation is a **separate, independent call** — `generateChatTitle()` (Haiku, plain-text, no JSON parsing) — gated by `needTitle`. Each call has its own try/catch and logs on failure rather than swallowing silently.

`assembleSystemPrompt` (`lib/promptAssembly.ts`) injects user memory as `- [memId] text` lines, project memory in a separate "About this project:" block, and a project manifest (files + sibling chats) for project chats.

`bedrock.ts` builds the tool list via `buildToolsWithCache(settings, ctx?)`: web tools when `webSearchEnabled !== false`; Core browser tools when `browserCoreEnabled !== false`; `browse_web` when `browserExtendedEnabled === true`; memory tool when `memoryEnabled !== false`; project memory tool + two read tools when `ctx?.projectId`; cachePoint always last.

## User preferences

`lib/preferences.ts` defines `UserPreferences`: `persona`, `defaultModel`, `thinkingEffort`, `webSearchEnabled`, `webSearchProvider` (`'jina'|'agentcore'`), `browserCoreEnabled`, `browserExtendedEnabled`, `temperature`, `topP`, `topK`, `answerLength` (`default|short|extensive`), `injectCurrentDate`, `showTokenStats`. `resolvePreferences(prefs)` merges layers (user → project → chat). Stored as a JSON blob in the `PREF#USER` row's `prefs` attribute.

## Attachments

`lib/attachments.ts` handles the full attachment lifecycle:
- **Validate**: `validateAttachment(contentType, sizeBytes, filename)` — images (png/jpeg/gif/webp ≤5 MB) and pdf (≤25 MB) matched by exact contentType; everything else classified primarily by **file extension** (`TEXT_EXTENSIONS`) since browsers report inconsistent contentType for text/code files. Bedrock's document block accepts only `pdf/csv/doc/docx/html/md/txt/xls/xlsx` as `format`, so everything not csv/md/pdf is sent as `txt`.
- **Upload**: `POST /api/attachments` returns `{s3Key, uploadUrl}` (S3 presigned PUT, 15-min expiry). Client uploads directly to S3.
- **Display**: `signCloudFrontUrl(s3Key)` issues a signed CloudFront URL (1-hour expiry) using an RSA private key loaded from SSM.
- **Inference**: `hydrateBlocks(blocks)` fetches bytes from S3 for image/document blocks before the Bedrock call (blocks carry `s3://bucket/key` at rest).
- **Fork**: `copyChatObjects` copies S3 objects; `rewriteBlockUri` patches copied blocks to point at new keys.

## HTTP API routes

| Route | Handler |
|-------|---------|
| `GET /api/chats` | list chats |
| `POST /api/chats` | create chat (optional `projectId`) |
| `PATCH /api/chats/{chatId}` | update title / systemPrompt / model / activeLeafId / modelSettings / projectId / summary / topics |
| `DELETE /api/chats/{chatId}` | delete chat + S3 objects |
| `POST /api/chats/{chatId}/retitle` | AI-generated title |
| `POST /api/chats/{chatId}/fork` | clone active-path into new chat |
| `DELETE /api/chats/{chatId}/messages/{msgId}` | delete message subtree |
| `GET /api/chats/{chatId}/messages` | full tree walk + attachment URL signing |
| `POST /api/attachments` | presign S3 PUT → `{s3Key, uploadUrl}` |
| `GET /api/models` | list models |
| `GET /api/memory` | list user memories |
| `DELETE /api/memory/{memId}` | delete a memory |
| `GET /api/preferences` | get UserPreferences |
| `PUT /api/preferences` | save UserPreferences |
| `GET /api/projects` | list projects |
| `POST /api/projects` | create project |
| `GET /api/projects/{projectId}` | get project + member chats |
| `PATCH /api/projects/{projectId}` | update project fields |
| `DELETE /api/projects/{projectId}` | delete project (un-assigns chats, removes memory/files/S3) |
| `GET /api/projects/{projectId}/memory` | list project memories |
| `PATCH /api/projects/{projectId}/memory/{memId}` | edit a project memory's text/category |
| `DELETE /api/projects/{projectId}/memory/{memId}` | delete a project memory |
| `GET /api/projects/{projectId}/files` | list project files |
| `POST /api/projects/{projectId}/files` | request file upload → `{fileId, s3Key, uploadUrl}` |
| `PUT /api/projects/{projectId}/files/{fileId}` | finalize/process file → generates microLabel + summary |
| `PATCH /api/projects/{projectId}/files/{fileId}` | update inclusion mode and/or edit summary/microLabel |
| `DELETE /api/projects/{projectId}/files/{fileId}` | delete file + S3 objects |

## CloudWatch logging

All LLM calls emit single-line `JSON.stringify({event, ...})` records to stdout:

| `event` | Where | Key fields |
|---------|-------|-----------|
| `llm_call` purpose=`chat` | `sendMessage.ts` on stop | model, chatId, stopReason, inputTokens, outputTokens, cacheRead/WriteInputTokens |
| `llm_call` purpose=`enrich_turn` | `sendMessage.ts` post-turn | model, chatId, userAdded, projectAdded, hasSummary, hasTitle |
| `llm_call` purpose=`file_summary` | `http/projects.ts` finalize | model, projectId, fileId, filename |
| `memory_tool` | `memory.ts` per call | op (remember/update/forget), scope (user/project), result |
| `web_search` | `tools.ts` per call | provider (jina/agentcore), result |
| `browser_tool` | `tools.ts` per call | tool, result, stepCount?, screenshotCount, chatId |
| `search_history` | `lib/search.ts` per call | scope, corpusSize, resultCount, chatId |
| `search_history_truncated` | `lib/search.ts` corpus build | total, kept, scope, chatId |
| `stream_start` / `stream_error` / `stream_cancelled` | `sendMessage.ts` | — |
| `enrich_turn_error` | `sendMessage.ts` post-turn | chatId, error |
| `manifest_truncated` | `sendMessage.ts` manifest build | kind (files/chats), total, kept, projectId, chatId |
| `forced_files_truncated` | `sendMessage.ts` forced files build | skipped, totalKept, projectId, chatId |
| `chat_created/updated/deleted/forked`, `branch_deleted` | `http/chats.ts` | — |

## Projects

Projects group related chats + files and give the model project-scoped memory via **progressive disclosure**:

- **L0 manifest** (always): system prompt includes `[fileId] name — micro-label` and `[chatId] title — summary-snippet` for all non-`never` files and sibling chats (capped at 50 files / 30 chats). Navigational only.
- **L1 summary** (on-demand): `read_project_file` / `read_project_chat` with `detail:'summary'` returns the pre-computed summary.
- **L2 full** (on-demand): `detail:'full'` returns decoded text (capped via `capToolResultText`), image bytes, or full transcript.
- **Forced inclusion**: files with `inclusion:'always'` are injected directly into the system prompt (per-file cap 20 KB, total cap 80 KB). Files with `inclusion:'never'` are excluded from the manifest.
- **Chat summaries + topics**: every chat gets `summary` and `topics[]` refreshed post-turn via `summarizeChat()`. `summarizeChatById()` runs immediately when a chat is moved into a project.
- **File processing**: `summarizeFile()` produces `microLabel` + `summary`. PDFs also get an extracted-text sidecar. Status: `uploading → processing → ready / error`.
- **Ownership**: all tool executors validate `ctx.projectId` — never trust model-supplied ids.
- **Membership**: moving a chat is a single `projectId` attribute write — no re-keying of messages.
