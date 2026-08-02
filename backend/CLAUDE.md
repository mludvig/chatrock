# Backend

See root `CLAUDE.md` for commands, architecture overview, DynamoDB schema, and key gotchas.

## Backend structure

```
backend/prompts/           — system-prompt text files for enrichment/search/summarization/title calls (imported as strings via esbuild's `.txt` loader — see below)
backend/src/
  config/models.ts        — model registry with capabilities (provider/temperature/topP/topK/thinking/thinkingLevels/attachments/documents/promptCaching/region/maxOutputTokens)
  lib/bedrock.ts          — thin re-export façade over lib/llm/ (kept for `tests/lib/bedrock.test.ts`'s `jest.mock('../../src/lib/bedrock')` and other call sites) — see "LLM providers" below for where the real implementation lives
  lib/llm/                — provider-neutral chat abstraction — see "LLM providers" below
  lib/blocks.ts           — DELETED; capToolResultText/TOOL_RESULT_CAP/TOOL_RESULTS_ROUND_CAP moved into lib/llm/blocks.ts alongside the neutral Block shape
  lib/dynamo.ts           — DynamoDB access layer: buildTurnKey/buildChatKey, putMessagePair (TransactWriteCommand, atomic 2-item write), batchPutMessages/batchDeleteMessages (retry UnprocessedItems), setStreamCancel/isStreamCancelled; project/file/memory dynamo fns
  lib/tools.ts            — Bedrock tool specs: WEB_TOOLS, TAKE_SCREENSHOT_TOOL, GET_RENDERED_PAGE_TOOL, BROWSER_TOOL, MEMORY_TOOL, MANAGE_PROJECT_MEMORY_TOOL, READ_PROJECT_FILE_TOOL, READ_PROJECT_CHAT_TOOL, SEARCH_HISTORY_TOOL, GENERATE_IMAGE_TOOL; executeTool dispatcher (web_search routes to Jina or AgentCore per ToolContext.webSearchProvider; search_history dispatches to lib/search.ts; generate_image dispatches to lib/imageGen/tool.ts); ToolContext type (incl. searchScope)
  lib/imageGen/           — generate_image tool: registry.ts (ImageProvider interface + provider list — the seam for adding OpenAI/Google/BFL later), tool.ts (GENERATE_IMAGE_TOOL spec + executor), providers/bedrockStability.ts (the only provider today, Bedrock InvokeModel against Stability's Stable Image Ultra)
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

**Prompt files**: the system prompts for `enrichUserFacts`/`generateChatTitle`/`summarizeChat`/`enrichProjectFacts` (`lib/enrichment.ts`), `extractUserFacts` (`lib/memory.ts`, legacy/unused-in-prod path kept for its tests), `summarizeFile` (`lib/projectFiles.ts`), and `searchHistory` (`lib/search.ts`) live as plain `.txt` files under `backend/prompts/`, not as inline template-literal constants — makes them easy to find and edit without touching TS logic. `esbuild.config.mjs` sets `loader: { '.txt': 'text' }` so `import X from '../../prompts/foo.txt'` inlines the file's contents as a string at build time (a normal rebuild/deploy picks up edits — no runtime file read). `src/types/text-modules.d.ts` declares the `*.txt` module type for `tsc`; `tests/rawTextTransform.cjs` + the `transform` entry in `package.json`'s `jest` config give Jest the same import behavior. Tool-use *descriptions* (`lib/tools.ts`) and `promptAssembly.ts`'s per-fragment directive strings are NOT extracted — they're short, tightly interleaved with conditional/interpolation logic, and easy to find in their one file already.

## Model capabilities

`backend/src/config/models.ts` is the single source of truth. Each `Model` entry declares `capabilities: { provider, temperature, topP, topK, thinking, thinkingLevels?, attachments, documents, promptCaching, region?, maxOutputTokens? }`. `provider` is a `ProviderId` (`'bedrock-converse'|'bedrock-mantle'`, see "LLM providers" below) — it's what `lib/llm/registry.ts`'s `getProvider(modelId)` dispatches on. `thinking` is `'adaptive'` (Anthropic on Converse — `thinking.type=adaptive` + `output_config.effort`), `'effort'` (OpenAI on Mantle — a plain `reasoning.effort` dial), or `'none'` (Haiku 4.5). `thinkingLevels` restricts which of `ThinkingEffort`'s five levels (`off|low|medium|high|max`) a model accepts — omit for all five; GPT-5.6 omits `'off'` since it always reasons. `promptCaching` (`'auto'|'explicit'|'none'`) and `region` (per-model pin; undefined → the provider's own default) are descriptive capability metadata, not yet load-bearing for every provider. Adding a new model is one entry in the `MODELS` array; adding a new *provider* is one new file under `lib/llm/providers/` + one line in `registry.ts`.

Each adapter's `streamTurn` reads `getCapabilities(modelId)` to build its own inference params — e.g. Converse suppresses temperature/topP when thinking is active (API requirement) and uses `caps.maxOutputTokens` for `inferenceConfig.maxTokens`.

**Stale model self-healing**: when a model id is retired/renamed from `MODELS` (e.g. the Sonnet 4.6 → 5 rename), no alias table is kept — a chat's stored `model` just goes stale. `http/chats.ts`'s `resolveChatModel()` self-heals it lazily the next time the chat is read (`GET /api/chats`, `GET /api/chats/{chatId}`, and fork's read of the source chat): swaps in `DEFAULT_CHAT_MODEL`, persists it via `updateChatModel`, and returns `modelMigratedFrom: <oldId>` in that one response so the frontend can show a one-time notice (`ChatView.tsx`, cleared via `clearModelMigrationNotice`). Only affects the *next* message — each `Message` row's own `model` field is a historical record of what actually generated that turn and is never rewritten, so past turns still show what was really used.

## LLM providers

Chatrock speaks two inference APIs behind one provider-neutral abstraction — `lib/llm/`:

```
lib/llm/
  blocks.ts                      — the neutral Block/NeutralMessage format (kind-discriminated: text/thinking/
                                    tool_call/tool_result/image/document); Opaque{provider,v,data} for provider-
                                    private continuation material (Anthropic signature/redactedContent, OpenAI
                                    reasoning id/encrypted_content); capToolResultText + tool-result caps
  toolSpec.ts                    — neutral ToolSpec (plain JSON Schema) + ToolResult/ToolResultEntry
  types.ts                       — StreamChunk, TokenUsage, TurnRequest/TurnResult/OnceRequest, ChatProvider
  toolGating.ts                  — buildToolList(settings, ctx): ToolSpec[], shared/provider-agnostic
  sanitize.ts                    — coalesceMessages/healDanglingToolUse/historyHasToolBlocks — Bedrock-Converse-
                                    wire-shaped helpers used internally by bedrockConverse's sanitizeHistory
  registry.ts                    — CHAT_PROVIDERS[], getProvider(modelId)
  loop.ts                        — converseStream()/converseOnce(), 100% provider-agnostic (dispatches via
                                    getProvider, no branch on provider anywhere in this file)
  providers/bedrockConverse.ts   — Anthropic (and any future Converse-served vendor) via Bedrock ConverseStream
  providers/converseTranslate.ts — pure Block[] <-> Bedrock ContentBlock[] translation, no I/O
  providers/bedrockMantle.ts     — OpenAI GPT-5.6 via Bedrock Mantle's Responses API
  providers/mantleTranslate.ts   — pure Block[]/NeutralMessage[] <-> Responses API item[] translation, no I/O
```

**The `ChatProvider` interface** (`types.ts`) is the whole seam: `id`, `sanitizeHistory(messages)`, `streamTurn(req): AsyncGenerator<StreamChunk, TurnResult>`, `once(req)`. `loop.ts`'s `converseStream()` calls `sanitizeHistory` once per invocation, then `streamTurn` once per agentic round — everything vendor-specific (cachePoint placement, inference params, toolChoice quirks, the tool-history-reoffer requirement) lives inside the adapter, never in `loop.ts`. `TurnRequest.cacheBoundaryIndex` is the index of the last stable-prior message in that round's `messages` array — the adapter places its one cache marker there; it's fixed for the whole invocation since only new-this-round messages grow the array. `TurnResult.replayContent`, when set, is what's carried into *this invocation's next round only* — never persisted — letting an adapter keep oversized live-only material (Mantle's full reasoning `encrypted_content` before `REASONING_OPAQUE_CAP` trims what's stored) out of DynamoDB.

**Provider ids are named by API surface, not vendor** (`bedrock-converse`, `bedrock-mantle`) — Converse also serves Meta/Mistral, so a vendor-named id would be misleading the moment a second Converse-served vendor is added. The id is persisted inside `Opaque.provider`, so getting this right avoids a future data migration.

**Cross-provider correctness** (mid-chat model switching): each adapter's `sanitizeHistory` drops any `ThinkingBlock` whose `opaque.provider` isn't its own — a foreign or absent signature is a hard `ValidationException` on Converse and meaningless on Mantle. Mantle does **not** re-emit a foreign thinking block as visible assistant text (that would misattribute another provider's internal reasoning as this model's own output) — silent drop is correct on both sides. Tool call ids round-trip **verbatim, never rewritten**, in both directions (Converse's `toolUseId` ↔ Mantle's `call_id` are just the same opaque string under different field names) — confirmed empirically, no id-rewriting fallback needed. Covered by `tests/lib/llm/crossProvider.test.ts`.

**Statelessness**: every Mantle request sends `store:false` and never `previous_response_id` — full history is replayed each call, required both for cross-provider switching (no server-side state to reconcile) and independently by the sensitive-chats posture (`Chat.sensitive`).

**Bedrock Mantle specifics** (`bedrockMantle.ts`): OpenAI's Responses API `input` is a **flat item array**, unlike Converse's per-message `ContentBlock[]` nesting — a `tool_call`/`tool_result`/`thinking` block becomes its own top-level item, not content inside a role message. `mantleTranslate.fromNeutralMessages` reflects that by operating on the whole history at once rather than per-message. Auth mirrors `bedrockAuth.ts`'s SigV4-primary/bearer-secondary precedence via the `bedrock()` provider from `openai/providers/bedrock/aws` (plain `OpenAI` client, **not** the bearer-only `BedrockOpenAI` class from `openai/bedrock` — that class's `apiKey` option is typed to reject AWS credentials entirely). All GPT-5.6 models are pinned to `us-east-1` (no `global.*` cross-region inference profile exists for Mantle, no `ap-southeast-2` availability as of Aug 2026). **IAM**: Mantle signs as a distinct service (`bedrock-mantle`, not `bedrock`) with its own action/resource shape — `bedrock-mantle:CreateInference` on a fixed per-account `arn:aws:bedrock-mantle:us-east-1:<account>:project/default`, **not** a per-model foundation-model/inference-profile ARN like Converse. This was derived from a real `AccessDeniedException` against the deployed Lambda, not guessed — AWS doesn't publish a clean signing-service-to-action mapping (see `terraform/iam.tf`'s `InvokeBedrockMantle` statement). Usage normalization: Responses' `input_tokens` is *inclusive* of cached tokens where Converse's *excludes* `cacheReadInputTokens` — `bedrockMantle.ts`'s `mapUsage` subtracts `input_tokens_details.cached_tokens` so a mixed-provider chat's transcript totals don't double-count.

## Conversation tree internals

**Atomic tool-use round persistence**: `ws/sendMessage.ts` defers writing an assistant turn that contains `tool_call` blocks until its paired tool-result turn is also ready, then writes both via `dynamo.ts`'s `putMessagePair` (`TransactWriteCommand`, 2 items). This guarantees the durable tree never ends on a dangling tool call. `lastTurnMsgId` only ever reflects the latest **durable** turn; a pending (not-yet-paired) turn's msgId is used solely to chain the next turn's `parentId` in memory. As defense-in-depth, each `ChatProvider`'s `sanitizeHistory` synthesizes a placeholder error tool-result for a tail assistant message with unresolved tool calls (Converse's `healDanglingToolUse` in `lib/llm/sanitize.ts`; Mantle's own `healDanglingToolCall` in `bedrockMantle.ts`, written directly against the neutral shape), right alongside role-coalescing (which handles two consecutive same-role turns from an interrupted loop) — both run unconditionally before every call, per-provider.

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

## Image generation

`generate_image` (`ModelSettings.imageGenerationEnabled`, default `false` — **opt-in**, unlike every other tool here, since each call costs money). Lives entirely under `lib/imageGen/`:

- **`registry.ts`** — the `ImageProvider` interface (`generate(req): Promise<GeneratedImage>`, plus `promptGuidance`/`supportsNegativePrompt`/`aspectRatios` metadata) and `IMAGE_PROVIDERS`/`getImageProvider()`. This is the extension seam: Bedrock has no frontier image model as of July 2026 (Nova Canvas/Titan Image Generator are Legacy, EOL 2026-09-30; no OpenAI/Google image model is offered on Bedrock at all — confirmed via `aws bedrock list-foundation-models`), so today's only provider is Stability AI via Bedrock. Adding a direct-API provider (OpenAI, Google, Black Forest Labs) later is one new file in `providers/` + one line in `IMAGE_PROVIDERS` — no changes needed to `tool.ts`, `bedrock.ts`'s image-result handling, or the frontend.
- **`tool.ts`** — `GENERATE_IMAGE_TOOL` spec (its `description` is built from the active provider's `promptGuidance` — see below) and `executeGenerateImageTool()`.
- **`providers/bedrockStability.ts`** — calls Bedrock `InvokeModel` (not `Converse` — image models don't support the Converse API) against `stability.stable-image-ultra-v1:1`. **Region gotcha**: Stability's Stable Image models exist as an on-demand Bedrock foundation model only in `us-west-2` as of July 2026 — absent from `ap-southeast-2` (where this backend otherwise runs), `us-east-1`, and `eu-west-1` (verified via `aws bedrock list-foundation-models --by-provider stability-ai --region <region>`). This provider therefore uses its own `BedrockRuntimeClient` pinned to `us-west-2`, a plain cross-region `InvokeModel` call — separate from the `ap-southeast-2` client `bedrock.ts` uses for Claude, and *not* a cross-region inference profile (image models don't have those).
- **Prompt-authoring guidance is data-driven per provider**, not hardcoded dispatch logic: Stability (like FLUX) takes the prompt literally with no server-side expansion, so its `promptGuidance` string tells the calling model to write a rich, self-contained description itself. A future auto-expanding/conversational provider (e.g. GPT Image, Gemini/Nano Banana) would carry lighter guidance — swapping providers changes what the model reads in the tool description without any code change to how it's invoked.

Generated images reuse `bedrock.ts`'s existing image-bearing-tool-result path unchanged (S3 upload, CloudFront signing, `screenshotUrls`) — the only change that path needed was generalizing its S3 key from a hardcoded `browser-` prefix to the actual tool name (`${tu.name}-${tu.toolUseId}-${i}.${format}`), since it was originally written only for browser screenshots.

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

`lib/llm/toolGating.ts`'s `buildToolList(settings, ctx?)` builds the neutral tool list (shared across providers): web tools when `webSearchEnabled !== false`; Core browser tools when `browserCoreEnabled !== false`; `browse_web` when `browserExtendedEnabled === true`; memory tool when `memoryEnabled !== false`; project memory tool + two read tools when `ctx?.projectId`. Each adapter lowers this to its own wire format and appends its own cache marker (Converse: trailing `cachePoint` on the tool list).

## User preferences

`lib/preferences.ts` defines `UserPreferences`: `persona`, `defaultModel`, `thinkingEffort`, `webSearchEnabled`, `webSearchProvider` (`'jina'|'agentcore'`), `browserCoreEnabled`, `browserExtendedEnabled`, `temperature`, `topP`, `topK`, `answerLength` (`default|short|extensive`), `injectCurrentDate`, `showTokenStats`. `resolvePreferences(prefs)` merges layers (user → project → chat). Stored as a JSON blob in the `PREF#USER` row's `prefs` attribute.

## Attachments

`lib/attachments.ts` handles the full attachment lifecycle:
- **Validate**: `validateAttachment(contentType, sizeBytes, filename)` — images (png/jpeg/gif/webp ≤5 MB) and pdf (≤25 MB) matched by exact contentType; everything else classified primarily by **file extension** (`TEXT_EXTENSIONS`) since browsers report inconsistent contentType for text/code files. Bedrock's document block accepts only `pdf/csv/doc/docx/html/md/txt/xls/xlsx` as `format`, so everything not csv/md/pdf is sent as `txt`.
- **Upload**: `POST /api/attachments` returns `{s3Key, uploadUrl}` (S3 presigned PUT, 15-min expiry). Client uploads directly to S3.
- **Display**: `signCloudFrontUrl(s3Key)` issues a signed CloudFront URL (1-hour expiry) using an RSA private key loaded from SSM.
- **Inference**: `hydrateBlocks(blocks)` fetches bytes from S3 for image/document blocks before the Bedrock call (blocks carry `s3://bucket/key` at rest).
- **Fork**: `copyChatObjects` copies S3 objects; `rewriteBlockUri` patches copied blocks to point at new keys.

## Chat deletion & sensitive/ephemeral chats

**Cascade delete**: `DELETE /api/chats/{chatId}` (`http/chats.ts`) only deletes the Chat item (`dynamo.ts`'s `deleteChatItem`). The resulting DynamoDB Stream `REMOVE` event (table has `stream_view_type = KEYS_ONLY`, `terraform/dynamodb.tf`) triggers `stream_chat_cleanup` (`streams/chatTtlCleanup.ts`, bundled as `stream-chatCleanup`), which cascades the delete to that chat's Message items (`dynamo.ts`'s `deleteChatMessages`) and S3 attachments (`attachments.ts`'s `deleteChatObjects`). The event source mapping's `filter_criteria` (`terraform/stream_chat_cleanup.tf`) restricts invocation to `REMOVE` events where `PK` begins with `USER#` and `SK` begins with `CHAT#` — a Chat-item delete specifically, so a Message-item removal (`PK = CHAT#<chatId>`) can never self-trigger it. Same path drives both manual delete and TTL expiry (DynamoDB's own background TTL sweep issues the identical `REMOVE` event), so there's one cascade implementation instead of two. On-failure destination is `chat_cleanup_dlq` (SQS) — a transient S3/DynamoDB error during cascade lands there instead of silently orphaning data.

Accepted tradeoffs: a few-second window after a manual delete where messages are still fetchable by direct URL/API (the stream fires within seconds of the `DeleteItem`, not instantly); DynamoDB's TTL background sweep has AWS's documented ~48h fuzziness before it actually deletes an expired item (only affects ephemeral-chat expiry, not manual delete).

**Sensitive & ephemeral chats**: two independent per-chat boolean flags — deliberately not fused into one "private" flag, since "never mine this" and "auto-delete this" turned out to be separate user decisions (e.g. a sensitive chat someone decides is worth keeping forever, or a throwaway non-sensitive chat that's fine to contribute to memory before it expires):

- **`sensitive`** — excluded from everything that could resurface this chat's content *outside itself*: user-fact memory, project-fact memory, and the `summarize`d text that `search_history` indexes. Auto-title (and manual retitle) is **allowed** — the title is stored on the chat itself and is a frontend display-filter concern (masked in the LHS unless revealed), not a content-leak concern like memory/summary/search are.
- **`ephemeral`** (+ `ttl`) — auto-deletes via the cascade-delete path above. `ttl` is fixed at creation (or whenever `ephemeral` is turned on), not sliding: `now + EPHEMERAL_CHAT_TTL_SECONDS`. `EPHEMERAL_CHAT_TTL_SECONDS` comes from the `ephemeral_chat_ttl_seconds` tfvar (gitignored `terraform/terraform.tfvars`; set low e.g. `86400` while testing the expiry path, raise once verified — default in `variables.tf` is 7 days).

Both flags are valid in any combination, including together in a project — a sensitive chat still reads project instructions/files/memory in (no leak, since nothing flows *out* of the project), it just never writes facts back. An `ephemeral`-but-not-`sensitive` project chat contributing facts before it expires is a legitimate, deliberate user choice, not a footgun.

- `GET /api/chats` (list) returns sensitive chats like any other — **visibility is a frontend concern** (the sidebar/ProjectView filter dialog, default hidden), not an API-level exclusion. `chatDto()` includes `sensitive: true` / `ephemeral: true, expiresAt` only when set.
- `enrichUserFacts`/`enrichProjectFacts`/`summarizeChat` (`ws/sendMessage.ts`'s post-turn enrichment block) are skipped when `chat.sensitive`; title generation runs regardless (see above). This is the part most likely to leak sensitive content if missed.
- `POST /api/chats/{chatId}/resummarize` (`http/chats.ts`) rejects with 400 for a sensitive chat — summary is what `search_history` indexes, so it must never run even on manual trigger. `retitle` has no such guard; title generation is allowed for sensitive chats.
- `buildSearchHistoryCorpus` (`lib/search.ts`) excludes `sensitive` chats from `chatCorpusItems` — otherwise a sensitive chat becomes discoverable through `search_history` from an unrelated chat.
- Forking (`POST /.../fork`) inherits both flags from the source; `ephemeral` gets a **fresh** `ttl` (a fork is itself a creation event), never the source's remaining one.
- `updateChatSensitive`/`updateChatEphemeral` (`dynamo.ts`) fully `REMOVE` the attribute when turning a flag off (not just set `false`) so a stale value never lingers for `chatDto()` to read, and so DynamoDB's TTL sweep stops considering the item once `ephemeral` is cleared.
- Table's `ttl` attribute (`terraform/dynamodb.tf`) was already enabled for `CONN#` WebSocket-connection rows (`ws/connect.ts`) — ephemeral chats are the second user of it.

**Frontend**: the LHS ("Private" preset button on `/c/new`, threaded into `api.createChat(..., {sensitive, ephemeral})`) sets both flags together at creation; once a chat exists, a cog button in `ChatView.tsx`'s header (next to the model select) opens a small popover to toggle `sensitive`/`ephemeral` independently via `api.updateChatFlags`. Since sensitive chats are returned by `GET /api/chats` like any other, they live in the normal Zustand `chats` array — no separate store slot. Visibility is a client-side filter: `ChatListFilter.tsx` (shared by `ChatsPanel` and `ProjectView`) has a "show sensitive chats" toggle, default off, plus the pre-existing "show project chats" toggle folded into the same popover; revealed sensitive chats render with an italic title. The chat header itself never shows a sensitive chat's title (only a discreet "Private" chip) — a bold header would announce the topic even with the sidebar closed. Visuals: `.chat-view--private` violet tint (header/messages/input area) and a footer line showing `expiresAt` when `ephemeral`.

## HTTP API routes

| Route | Handler |
|-------|---------|
| `GET /api/chats` | list chats (includes sensitive chats — visibility is a frontend filter) |
| `POST /api/chats` | create chat (optional `projectId`, `sensitive`, `ephemeral`) |
| `GET /api/chats/{chatId}` | get one chat's metadata |
| `PATCH /api/chats/{chatId}` | update title / systemPrompt / model / activeLeafId / modelSettings / projectId / summary / topics / sensitive / ephemeral |
| `DELETE /api/chats/{chatId}` | delete the Chat item; cascade to messages/S3 runs via the stream_chat_cleanup Lambda (see below) |
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
