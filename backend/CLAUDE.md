# Backend

See root `CLAUDE.md` for commands, architecture overview, DynamoDB schema, and key gotchas.

## Backend structure

```
backend/prompts/           — system-prompt text files for enrichment/search/summarization/title calls (imported as strings via esbuild's `.txt` loader — see below)
backend/src/
  config/models.ts        — model registry with capabilities (provider/thinking/thinkingLevels/attachments/documents/promptCaching/region/maxOutputTokens)
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
  lib/subAgent.ts         — runResearchTask(): the run_research_task tool executor — runs a bounded converseStream() loop of its own (web tools only, no chat history/memory) and returns a capped plain-text answer (docs/adr/0039)
  lib/projectContext.ts   — executeProjectReadFileTool / executeProjectReadChatTool: ownership validation, progressive detail (summary vs full), capToolResultText applied
  lib/promptAssembly.ts   — assembleSystemPrompt: merges instructions + date + answer-length + user memory + project memory + project manifest + forced files
  lib/preferences.ts      — UserPreferences type + resolvePreferences() layering
  http/chats.ts           — chat CRUD, retitle, fork, branch delete, attachment presign; PATCH accepts projectId for project membership
  http/messages.ts        — GET /messages: tree walk + attachment URL signing + `streaming` flag
  http/models.ts          — GET /models
  http/memory.ts          — GET /memory, DELETE /memory/{memId}
  http/preferences.ts     — GET /preferences, PUT /preferences
  http/projects.ts        — project CRUD + project memory + project file routes (single Lambda dispatching on routeKey)
  ws/sendMessage.ts       — the core streaming handler (the most complex file)
  ws/cancelMessage.ts     — sets DynamoDB cancel flag; stream loop polls and aborts via AbortController
  ws/authorizer.ts        — WebSocket Lambda authorizer
```

Each Lambda is bundled independently by esbuild into `terraform/dist/<name>.zip`.

**Prompt files**: the system prompts for `enrichUserFacts`/`generateChatTitle`/`summarizeChat`/`enrichProjectFacts` (`lib/enrichment.ts`), `extractUserFacts` (`lib/memory.ts`, legacy/unused-in-prod path kept for its tests), `summarizeFile` (`lib/projectFiles.ts`), `searchHistory` (`lib/search.ts`), the `researchDepth === 'deep'` system-prompt fragment (`promptAssembly.ts`, `prompts/deep-research.txt`), and the researcher sub-agent's own system prompt (`lib/subAgent.ts`, `prompts/research-task.txt`) live as plain `.txt` files under `backend/prompts/`, not as inline template-literal constants — makes them easy to find and edit without touching TS logic. `esbuild.config.mjs` sets `loader: { '.txt': 'text' }` so `import X from '../../prompts/foo.txt'` inlines the file's contents as a string at build time (a normal rebuild/deploy picks up edits — no runtime file read). `src/types/text-modules.d.ts` declares the `*.txt` module type for `tsc`; `tests/rawTextTransform.cjs` + the `transform` entry in `package.json`'s `jest` config give Jest the same import behavior. Tool-use *descriptions* (`lib/tools.ts`) and `promptAssembly.ts`'s per-fragment directive strings are NOT extracted — they're short, tightly interleaved with conditional/interpolation logic, and easy to find in their one file already.

## Model capabilities

`backend/src/config/models.ts` is the single source of truth. Each `Model` entry declares `capabilities: { provider, thinking, thinkingLevels?, attachments, documents, promptCaching, maxOutputTokens? }`. `provider` is a `ProviderId` (`'bedrock-converse'|'bedrock-responses'`, see "LLM providers" below) — it's what `lib/llm/registry.ts`'s `getProvider(modelId)` dispatches on. `thinking` is `'adaptive'` (Anthropic on Converse — `thinking.type=adaptive` + `output_config.effort`), `'effort'` (OpenAI on the Responses API — a plain `reasoning.effort` dial), or `'none'` (Haiku 4.5). `thinkingLevels` restricts which of `ThinkingEffort`'s five levels (`off|low|medium|high|max`) a model accepts — omit for all five; GPT-5.6 omits `'off'` since it always reasons. `promptCaching` (`'auto'|'explicit'|'none'`) is descriptive capability metadata, not yet load-bearing for every provider. Adding a new model is one entry in the `MODELS` array; adding a new *provider* is one new file under `lib/llm/providers/` + one line in `registry.ts`.

Each adapter's `streamTurn` reads `getCapabilities(modelId)` to build its own inference params — e.g. Converse uses `caps.maxOutputTokens` for `inferenceConfig.maxTokens`.

**Retired models**: to retire a model, delete its `MODELS` entry and add its id to its successor's `replaces` list (carrying over the retired entry's own `replaces`, so lookups stay one step deep — `tests/config/models.test.ts` enforces no live id in any list and no id in two lists). `currentModelId()` maps a stored id to the live id or its successor; `resolveModelId()` adds `DEFAULT_CHAT_MODEL` as the last resort (`docs/adr/0050-retired-models-hand-off-to-a-successor.md`). `ws/sendMessage.ts` runs a retired id on its successor and rejects an id nothing replaces; user-prefs and project `defaultModel` read as the successor or unset. `lib/chatDto.ts`'s `resolveChatModel()` substitutes the resolved model in the response only (`GET /api/chats`, `GET /api/chats/{chatId}`, project member chats, fork's read of the source chat) and adds `modelMigratedFrom: <oldId>` so the frontend can show a notice (`ChatView.tsx`, cleared via `clearModelMigrationNotice`). Reads never write: the stored model changes only when the next message is sent, via `recordChatSend` (`docs/adr/0049-sort-chats-by-last-message-and-save-composer-choices-on-send.md`), which also stamps `lastMessageAt` and merges the sent thinking effort/research depth into `modelSettings`. Only affects the *next* message — each `Message` row's own `model` field is a historical record of what actually generated that turn and is never rewritten, so past turns still show what was really used.

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
                                    getProvider, no branch on provider anywhere in this file); the public
                                    converseStream is an observability shell around the agentic loop
  observability.ts               — logLlmCall(): the one place an `llm_call` record is written
  providers/bedrockConverse.ts   — Anthropic (and any future Converse-served vendor) via Bedrock ConverseStream
  providers/converseTranslate.ts — pure Block[] <-> Bedrock ContentBlock[] translation, no I/O
  providers/bedrockResponses.ts  — OpenAI GPT via the Responses API on bedrock-runtime
  providers/responsesTranslate.ts — pure Block[]/NeutralMessage[] <-> Responses API item[] translation, no I/O
```

**The `ChatProvider` interface** (`types.ts`) is the whole seam: `id`, `sanitizeHistory(messages)`, `streamTurn(req): AsyncGenerator<StreamChunk, TurnResult>`, `once(req)`. `loop.ts`'s `converseStream()` calls `sanitizeHistory` once per invocation, then `streamTurn` once per agentic round — everything vendor-specific (cachePoint placement, inference params, toolChoice quirks, the tool-history-reoffer requirement) lives inside the adapter, never in `loop.ts`. `TurnRequest.cacheBoundaryIndex` is the index of the last stable-prior message in that round's `messages` array — the adapter places its one cache marker there; it's fixed for the whole invocation since only new-this-round messages grow the array. A round whose stream dies before forwarding a single chunk is retried in `loop.ts` (2 attempts, 500/1500ms, transient errors only) — once anything has been forwarded the error propagates instead, since a retry would replay visible text: `docs/adr/0041-retrying-a-provider-round-that-produced-no-output.md`. `TurnResult.replayContent`, when set, is what's carried into *this invocation's next round only* — never persisted — letting an adapter keep oversized live-only material (the Responses provider's full reasoning `encrypted_content` before `REASONING_OPAQUE_CAP` trims what's stored) out of DynamoDB.

**Provider ids are named by API surface, not vendor** (`bedrock-converse`, `bedrock-responses`) — Converse also serves Meta/Mistral, so a vendor-named id would be misleading the moment a second Converse-served vendor is added. The id is persisted inside `Opaque.provider`, so getting this right avoids a future data migration.

**Cross-provider correctness** (mid-chat model switching): each adapter's `sanitizeHistory` drops any `ThinkingBlock` whose `opaque.provider` isn't its own — a foreign or absent signature is a hard `ValidationException` on Converse and meaningless on Responses. The Responses provider does **not** re-emit a foreign thinking block as visible assistant text (that would misattribute another provider's internal reasoning as this model's own output) — silent drop is correct on both sides. Tool call ids round-trip **verbatim, never rewritten**, in both directions (Converse's `toolUseId` ↔ Responses' `call_id` are just the same opaque string under different field names) — confirmed empirically, no id-rewriting fallback needed. Covered by `tests/lib/llm/crossProvider.test.ts`.

**Statelessness**: every Responses request sends `store:false` and never `previous_response_id` — full history is replayed each call, required both for cross-provider switching (no server-side state to reconcile) and independently by the sensitive-chats posture (`Chat.sensitive`).

**Bedrock Responses specifics** (`bedrockResponses.ts`): OpenAI's Responses API `input` is a **flat item array**, unlike Converse's per-message `ContentBlock[]` nesting — a `tool_call`/`tool_result`/`thinking` block becomes its own top-level item, not content inside a role message. `responsesTranslate.fromNeutralMessages` reflects that by operating on the whole history at once rather than per-message. The client is the plain `OpenAI` class with the `bedrock({ endpoint: 'runtime', region: bedrockRegion() })` provider from `openai/providers/bedrock/aws` (**not** the bearer-only `BedrockOpenAI` class from `openai/bedrock` — its `apiKey` option rejects AWS credentials), which targets `bedrock-runtime.<region>.amazonaws.com/openai/v1` and signs SigV4 as service `bedrock`, with the same bearer-token fallback as `bedrockAuth.ts`. GPT models are `global.openai.*` cross-region inference profiles called from the backend's own region, exactly like the Anthropic models. **IAM**: the usual `bedrock:InvokeModel*` on the inference profile, plus `bedrock:InvokeModel` on the account's `arn:aws:bedrock:<region>:<account>:project/default` (`terraform/iam.tf`). Why runtime rather than Mantle or Converse: `docs/adr/0048-openai-models-on-bedrock-runtime.md`. Usage normalization: Responses' `input_tokens` is *inclusive* of cached tokens where Converse's *excludes* `cacheReadInputTokens` — `bedrockResponses.ts`'s `mapUsage` subtracts `input_tokens_details.cached_tokens` so a mixed-provider chat's transcript totals don't double-count.

## Conversation tree internals

**Atomic tool-use round persistence**: `ws/sendMessage.ts` defers writing an assistant turn that contains `tool_call` blocks until its paired tool-result turn is also ready, then writes both via `dynamo.ts`'s `putMessagePair` (`TransactWriteCommand`, 2 items). This guarantees the durable tree never ends on a dangling tool call. `lastTurnMsgId` only ever reflects the latest **durable** turn; a pending (not-yet-paired) turn's msgId is used solely to chain the next turn's `parentId` in memory. As defense-in-depth, each `ChatProvider`'s `sanitizeHistory` synthesizes a placeholder error tool-result for a tail assistant message with unresolved tool calls (Converse's `healDanglingToolUse` in `lib/llm/sanitize.ts`; the Responses provider's own `healDanglingToolCall` in `bedrockResponses.ts`, written directly against the neutral shape), right alongside role-coalescing (which handles two consecutive same-role turns from an interrupted loop) — both run unconditionally before every call, per-provider.

`batchPutMessages`/`batchDeleteMessages` (fork-copy, subtree-delete) retry `BatchWriteCommand`'s `UnprocessedItems` and throw if items remain unprocessed after retries, rather than silently leaving a partial result.

## Web search providers

`lib/tools.ts` implements `web_search` against two interchangeable backends, selected per-call by `ToolContext.webSearchProvider`. Both map into the identical `{ results: [{title,url,description}], text }` JSON contract. `web_fetch` always uses Jina.
- **Jina** (default): `jinaSearch`/`jinaFetch` call `s.jina.ai/{query}` / `r.jina.ai/{url}` with `JINA_API_KEY` (terraform var `jina_api_key`, optional). Both go through `jinaGetJson`, which retries once (400ms) on a network throw or 408/429/5xx and never on another 4xx. A failed or empty result carries a hint pointing the model at `get_rendered_page` (for a search: on a DuckDuckGo URL), gated on `ToolContext.browserAvailable` — set by `loop.ts` from the tool list it built, so a browser-less research sub-agent isn't told to call a tool it doesn't have. Why: `docs/adr/0042-jina-retry-and-browser-fallback.md`.
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
- **Passive enrichment** (`sendMessage.ts` post-turn, `lib/enrichment.ts`): runs per turn when `memoryEnabled`, reconciling against memories **re-read fresh AFTER the agentic loop** (not the pre-loop system-prompt snapshot) so mid-loop `manage_memory` writes get merged, not duplicated. Why: `docs/adr/0007-passive-enrichment-fresh-reads.md`.

`enrichUserFacts()` (Sonnet) always runs; `summarizeChat()` (Sonnet) also always runs, merging the latest exchange into the chat's running summary + `topics[]`. When the chat belongs to a project, `enrichProjectFacts()` (Sonnet) additionally runs. Title generation is a **separate, independent call** — `generateChatTitle()` (Haiku, plain-text, no JSON parsing) — gated by `needTitle`. Each call has its own try/catch and logs on failure rather than swallowing silently.

`assembleSystemPrompt` (`lib/promptAssembly.ts`) injects user memory as `- [memId] text` lines, project memory in a separate "About this project:" block, and a project manifest (files + sibling chats) for project chats.

`lib/llm/toolGating.ts`'s `buildToolList(settings, ctx?)` builds the neutral tool list (shared across providers): web tools when `webSearchEnabled !== false`; Core browser tools when `browserCoreEnabled !== false`; `browse_web` when `browserExtendedEnabled === true`; memory tool when `memoryEnabled !== false`; project memory tool + two read tools when `ctx?.projectId`. Each adapter lowers this to its own wire format and appends its own cache marker (Converse: trailing `cachePoint` on the tool list).

## User preferences

`lib/preferences.ts` defines `UserPreferences`: `persona`, `defaultModel`, `thinkingEffort`, `webSearchEnabled`, `webSearchProvider` (`'jina'|'agentcore'`), `browserCoreEnabled`, `browserExtendedEnabled`, `answerLength` (`default|short|extensive`), `injectCurrentDate`, `showTokenStats`. `resolvePreferences(prefs)` merges layers (user → project → chat). Stored as a JSON blob in the `PREF#USER` row's `prefs` attribute.

## Attachments

`lib/attachments.ts` handles the full attachment lifecycle:
- **Validate**: `validateAttachment(contentType, sizeBytes, filename)` — images (png/jpeg/gif/webp ≤5 MB) and pdf (≤25 MB) matched by exact contentType; everything else classified primarily by **file extension** (`TEXT_EXTENSIONS`) since browsers report inconsistent contentType for text/code files. Bedrock's document block accepts only `pdf/csv/doc/docx/html/md/txt/xls/xlsx` as `format`, so everything not csv/md/pdf is sent as `txt`.
- **Upload**: `POST /api/attachments` returns `{s3Key, uploadUrl}` (S3 presigned PUT, 15-min expiry). Client uploads directly to S3. Why direct-PUT instead of proxying through Lambda: `docs/adr/0011-presigned-s3-direct-put-uploads.md`.
- **Display**: `signCloudFrontUrl(s3Key)` issues a signed CloudFront URL (1-hour expiry) using an RSA private key loaded from SSM.
- **Inference**: `hydrateBlocks(blocks)` fetches bytes from S3 for image/document blocks before the Bedrock call (blocks carry `s3://bucket/key` at rest).
- **Fork**: `copyChatObjects` copies S3 objects; `rewriteBlockUri` patches copied blocks to point at new keys.

## Chat deletion & sensitive/ephemeral chats

**Cascade delete** (why streams instead of a synchronous handler cascade: `docs/adr/0006-cascade-delete-via-dynamodb-streams.md`): `DELETE /api/chats/{chatId}` (`http/chats.ts`) only deletes the Chat item (`dynamo.ts`'s `deleteChatItem`). The resulting DynamoDB Stream `REMOVE` event (table has `stream_view_type = KEYS_ONLY`, `terraform/dynamodb.tf`) triggers `stream_chat_cleanup` (`streams/chatTtlCleanup.ts`, bundled as `stream-chatCleanup`), which cascades the delete to that chat's Message items (`dynamo.ts`'s `deleteChatMessages`) and S3 attachments (`attachments.ts`'s `deleteChatObjects`). The event source mapping's `filter_criteria` (`terraform/stream_chat_cleanup.tf`) restricts invocation to `REMOVE` events where `PK` begins with `USER#` and `SK` begins with `CHAT#`, so a Message-item removal can never self-trigger it. Same path drives both manual delete and TTL expiry. On-failure destination is `chat_cleanup_dlq` (SQS).

**Sensitive & ephemeral chats** (why two independent flags instead of one "private" flag: `docs/adr/0008-sensitive-and-ephemeral-are-independent-flags.md`):

- **`sensitive`** — excluded from everything that could resurface this chat's content *outside itself*: user-fact memory, project-fact memory, and the `summarize`d text that `search_history` indexes. Auto-title (and manual retitle) is **allowed** — the title is a frontend display-filter concern (masked in the LHS unless revealed), not a content-leak concern.
- **`ephemeral`** (+ `ttl`) — auto-deletes via the cascade-delete path above. `ttl` is fixed at creation (or whenever `ephemeral` is turned on), not sliding: `now + EPHEMERAL_CHAT_TTL_SECONDS` (`ephemeral_chat_ttl_seconds` tfvar, default 7 days in `variables.tf`).

Both flags combine freely, including inside a project — a sensitive chat still reads project instructions/files/memory in, it just never writes facts back out.

Call sites that must check `sensitive` (miss one of these and content leaks outside the chat):
- `enrichUserFacts`/`enrichProjectFacts`/`summarizeChat` (`ws/sendMessage.ts`'s post-turn enrichment block) — skipped when `chat.sensitive`; title generation runs regardless.
- `POST /api/chats/{chatId}/resummarize` (`http/chats.ts`) — rejects with 400 for a sensitive chat; `retitle` has no such guard.
- `buildSearchHistoryCorpus` (`lib/search.ts`) — excludes `sensitive` chats from `chatCorpusItems`.

Other mechanics: `GET /api/chats` returns sensitive chats like any other (visibility is a frontend concern, not an API-level exclusion — `chatDto()` includes `sensitive`/`ephemeral`/`expiresAt` only when set). Forking inherits both flags from the source; `ephemeral` gets a **fresh** `ttl`. `updateChatSensitive`/`updateChatEphemeral` (`dynamo.ts`) fully `REMOVE` the attribute when turning a flag off, not just set `false`. Table's `ttl` attribute was already enabled for `CONN#` rows — ephemeral chats are the second user of it.

**Frontend**: see "Sensitive & ephemeral chats" in `frontend/CLAUDE.md`.

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
| `GET /api/chats/{chatId}/messages` | full tree walk + attachment URL signing + `streaming`/`streamingDeadlineAt` |
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
| `llm_call` | `lib/llm/loop.ts` — every `converseStream`/`converseOnce` invocation | purpose, model, provider, ok, durationMs, sub/chatId/projectId/runId (whichever the caller set), rounds, stopReason, inputTokens, outputTokens, cacheRead/WriteInputTokens, error |
| `memory_tool` | `memory.ts` per call | op (remember/update/forget), scope (user/project), result |
| `web_search` | `tools.ts` per call | provider (jina/agentcore), result (success/error), error |
| `web_fetch` | `tools.ts` on failure | result (error), error |
| `jina_retry` | `tools.ts` when a Jina call is retried | what (search/fetch), error |
| `llm_round_retry` | `lib/llm/loop.ts` when a no-output round is retried | model, provider, round, attempt, error |
| `browser_tool` | `tools.ts` per call | tool, result, stepCount?, screenshotCount, chatId |
| `search_history` | `lib/search.ts` per call | scope, corpusSize, resultCount, chatId |
| `search_history_truncated` | `lib/search.ts` corpus build | total, kept, scope, chatId |
| `stream_start` / `stream_error` / `stream_cancelled` | `sendMessage.ts` | — |
| `enrich_turn_error` | `sendMessage.ts` post-turn | chatId, error |
| `manifest_truncated` | `sendMessage.ts` manifest build | kind (files/chats), total, kept, projectId, chatId |
| `forced_files_truncated` | `sendMessage.ts` forced files build | skipped, totalKept, projectId, chatId |
| `chat_created/updated/deleted/forked`, `branch_deleted` | `http/chats.ts` | — |

`llm_call` is emitted **only** by the wrapper — no call site logs its own token stats (why:
`docs/adr/0029-llm-observability-in-the-wrapper.md`). Both `converseStream` and `converseOnce`
require a `call: LlmCallContext` — `purpose` (a closed union: `chat`, `chat_title`,
`chat_summary`, `enrich_user_facts`, `enrich_project_facts`, `extract_user_facts`,
`file_summary`, `search_history`, `research_task`) plus whichever of
`sub`/`chatId`/`projectId`/`runId` correlate that call — so a new call site can't be added
unlabelled. `research_task` is the researcher sub-agent's own `converseStream` call
(`lib/subAgent.ts`) — a deep turn's orchestrator round itself still logs under `chat`. A failed call emits the same event with
`ok:false` + `error` on stderr, so one Insights filter on `event = "llm_call"` covers both.

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

## Project policy and defaults

See `docs/adr/0044-project-context-and-memory-policy.md`. Project responses retain
model defaults/settings and use the shared chat DTO for member chats. PATCH
`defaultModel: null` resets the project override. Project GET performs no enrichment.
Sensitive chats are excluded from sibling manifests, cross-chat reads, memory
tools and summary backfills. Excluded files are excluded from search and reads.
Project memory has an additional gate independent of instructions/files. Titles
and non-sensitive summaries continue when memory learning is off. Retrieval and
backfill use the stored active conversation branch.

## Curated project knowledge

ADR 0046 adds `POST /api/projects/{projectId}/memory` for manual facts. UI-created
and UI-edited facts carry `userEdited: true`; passive reconciliation preserves
them. New automated facts record `sourceChatId`. GET project files returns a signed
`url` for ready originals and displays uploading/processing records older than
fifteen minutes as errors with recovery text. Finalization can be retried.
