# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Chatrock is a multi-user LLM chat web app on AWS: React SPA + TypeScript Lambda backend + API Gateway WebSocket streaming + Cognito auth + DynamoDB + S3/CloudFront. Live at `https://chatrock.ccxdemo.dev`.

See `backend/CLAUDE.md` for backend implementation detail. See `frontend/CLAUDE.md` for frontend detail.

## Architecture decisions

For any non-trivial design decision (a choice between real alternatives, not a straightforward bug fix), write an ADR to `docs/adr/NNNN-title.md` (four-digit sequence number, kebab-case title) alongside the implementation. Cover: Status, Context, Decision, Consequences (including alternatives considered and why they were rejected). Where the decision lands at a specific, identifiable spot in the code (a function, a resource block, a call site) — not every ADR does — add a one-line comment there pointing back to it (e.g. `// See docs/adr/0006-cascade-delete-via-dynamodb-streams.md`), so the rationale surfaces to anyone reading that code, not just anyone who thinks to check `docs/adr/`. See `docs/adr/` for the existing decision log — the "why" behind the single-table design, the conversation tree, cascade delete, sensitive/ephemeral flags, and more all live there; this file and `backend`/`frontend` `CLAUDE.md` stick to the "how it works" so they don't drift out of sync with the ADRs' rationale.

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

Frontend unit tests run with `npm --prefix frontend test` (Vitest). Type-checking is part of `npm run build` (tsc runs first).

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
- **Streaming**: client sends `{ action: 'sendMessage', chatId, content?, model, systemPrompt, modelSettings, parentId? }` over WebSocket. `ws/sendMessage.ts` persists the user message (if `content` present), calls Bedrock `ConverseStream` in an agentic loop (3/8/12 rounds by research depth — `docs/adr/0020-research-depth-and-budget-pacing.md`), pushes event frames back via `ApiGatewayManagementApi.postToConnection`. See WS payload contract below.
- **Cancel**: client sends `{ action: 'cancelMessage', chatId }` over WebSocket. `ws/cancelMessage.ts` sets a DynamoDB cancel flag on the chat row, keyed `(sub, chatId)` so cancelling one chat can never abort a different chat's turn on the same connection (`docs/adr/0040-concurrent-per-chat-streaming.md`); the stream loop polls it every 750ms via `isStreamCancelled`, aborts the Bedrock stream via `AbortController`, flushes any partial text as a turn, then emits `cancelled`.

### DynamoDB single-table

Why one table instead of one per entity: `docs/adr/0003-single-dynamodb-table.md`. Table `chatrock-prod` with PK/SK:
- Chat: `PK=USER#<sub>` / `SK=CHAT#<chatId>` — title, model, systemPrompt, modelSettings?, createdAt, updatedAt, **lastMessageAt** (stamped only on send; orders the chat list — `docs/adr/0049-sort-chats-by-last-message-and-save-composer-choices-on-send.md`), **activeLeafId**, projectId?, summary?, topics?, streamingSince?, streamingResponseId?, cancelRequested?
- Message (turn): `PK=CHAT#<chatId>` / `SK=MSG#<iso-timestamp>#<seq>#<msgId>` — role, **blocks**, model, createdAt, **msgId**, **parentId**, **responseId**, turnIndex, usage?, thinkingEffort?, webSearchEnabled?
- WS connection: `PK=CONN#<connId>` / `SK=CONN#<connId>` — userSub, TTL
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

Why a tree instead of a linear history: `docs/adr/0004-conversation-tree-model.md`. Each turn record has `msgId` (UUID) + `parentId` (null at root) forming a tree. `activeLeafId` on the chat record tracks the current branch tip. `GET /messages` does a single DynamoDB Query of the full `CHAT#<chatId>` partition, then walks the tree in memory to extract the active path and compute sibling metadata.

Key helpers in `backend/src/lib/tree.ts`:
- `buildActivePath(rows, leafId)` — leaf→root walk, reversed to root→leaf order. Falls back to `mostRecentLeaf(rows)` (not raw array order) when `leafId` doesn't resolve.
- `resolveLeaf(rows, msgId)` — walk DOWN to the deepest descendant (last child at each level)
- `resolveResponseLeaf(rows, msgId)` — same but stays within one `responseId` group
- `mostRecentLeaf(rows)` — tree-derived current leaf with no starting point: walks down from every root, picks whichever terminal leaf has the latest `createdAt`
- `resolveSafeLeaf(rows, candidateMsgId)` — validated chokepoint for moving `activeLeafId`: confirms candidateMsgId exists before resolving down; falls back to `mostRecentLeaf` rather than persisting a phantom pointer

`responseId` groups all turns of a single Bedrock call (initial text + tool-use turns + tool-result turns). A display bubble = one `responseId` group collapsed into steps[].

**WS payload contract** (`ws/sendMessage.ts` / `api/ws.ts`):
- Normal send: `{ chatId, content, model, systemPrompt, modelSettings, search? }` — persists user turn at current leaf, streams answer. `search: { scope: 'project'|'global' }` forces `search_history` tool on this turn.
- Re-run: `{ chatId, parentId, model, systemPrompt, modelSettings }` — no `content`; streams new sibling answer under `parentId`
- Edit: `{ chatId, parentId, content, model, systemPrompt, modelSettings }` — persists new user sibling under `parentId`, streams answer
- Cancel: `{ chatId }` — see Cancel above.

`safePost` (`ws/sendMessage.ts`) stamps `chatId` onto every outgoing frame in one place, so a client with more than one chat in flight on the same connection (`docs/adr/0040-concurrent-per-chat-streaming.md`) can route each frame to the right chat's state. A `researchDepth === 'deep'` turn's `ack` frame also carries `deadlineAt` — the wall-clock time the turn must wrap up by (`docs/adr/0039-deep-research-as-a-sub-agent-tool.md`).

`GET /messages` also returns `streaming` and, for a deep turn, `streamingDeadlineAt`: a turn is being generated for this chat right now, possibly for a connection this client no longer holds. The client polls on it to catch up after a dropped socket — see `docs/adr/0037-catching-up-on-a-dropped-stream.md`.

**Display bubble shape** (from `GET /messages`): each bubble includes `msgId`, `parentId`, `siblingIndex` (1-based), `siblingCount`, `siblings` (ordered msgId array).

### WebSocket event protocol

The server pushes JSON frames; the frontend `api/ws.ts` routes them to the Zustand store:

| `type` | payload |
|--------|---------|
| `thinking_delta` | `text` |
| `thinking_done` | — |
| `tool_call_start` | `toolUseId`, `name` — fires immediately at block start for fast UI feedback |
| `tool_call` | `toolUseId`, `name`, `input` — fires when full input JSON is accumulated |
| `tool_result` | `toolUseId`, `name`, `isError`, `content`, `screenshotUrls?` — `screenshotUrls` is a first-class array of signed CloudFront URLs for browser-tool screenshots, never embedded as JSON inside `content` |
| `sub_agent_progress` | `toolUseId` (the parent `run_research_task` call), `name`, `text` — live-only narration of a research sub-agent's own tool calls; dropping one costs nothing, the finding lands as that call's `tool_result` |
| `delta` | `text` |
| `done` | `stopReason` |
| `cancelled` | — (stream was aborted by `cancelMessage`) |
| `usage` | `usage` (inputTokens, outputTokens, cache*) |
| `titleUpdated` | `chatId`, `title` |
| `memoryUpdated` | `count` — number of new memories extracted this turn |
| `warning` | `message` — non-fatal post-turn failure (enrichment DB write failed, etc.) |
| `heartbeat` | — sent every `HEARTBEAT_INTERVAL_MS` (4s) while a single tool call is still in flight |
| `error` | `message` |

## Real-time reliability

Clients are frequently phones that background mid-turn, sleep past a token's expiry, and
resume on another network. `docs/realtime-reliability.md` is the standing set of rules that
follow from that — the server finishes work with nobody listening, catch-up is a refetch
rather than a re-attach, every push path needs a pull equivalent, liveness markers expire,
credentials are read at connect time, and retry loops end in something the user can act on.
Read it before adding anything that streams, polls, or reconnects; it ends in a checklist.

## Key gotchas

- **Inference profiles**: models use `global.*` cross-region inference profiles (`global.anthropic.claude-opus-4-8` etc.), not direct model IDs. Verify with `aws bedrock list-inference-profiles --region ap-southeast-2 --type-equals SYSTEM_DEFINED`.
- **Thinking API**: adaptive thinking (`type=adaptive` + `output_config.effort`) is what Opus 4.8 and Sonnet 4.6 expect — not `type=enabled`/`budget_tokens`. Temperature/topP must be absent when thinking is active. Forced `toolChoice` and thinking are mutually exclusive — `converseStream` disables thinking for the forced-toolChoice round.
- **WS authorizer**: TTL caching (`authorizer_result_ttl_in_seconds`) is not valid for WebSocket APIs — omit it.
- **`cd` in Bash**: avoid `cd` in commands; use `--prefix` or absolute paths to keep auto-approval working.
- **Screenshots**: save to `.screenshots/YYYY-MM-DD-description.jpg`.
- **AgentCore Gateway target type**: `aws_bedrockagentcore_gateway_target` (AWS provider v6.51.0) doesn't yet support the `connector` target type that Web Search needs — only the *gateway* is a real Terraform resource (`terraform/agentcore.tf`); the target is a one-time manual `aws bedrock-agentcore-control create-gateway-target` step (comment in that file has the exact command). Needs AWS CLI ≥ 2.35.7 — older builds reject the `connector` parameter outright.
- **AgentCore Browser IAM ARN**: the AWS-managed system browser lives under the literal `aws` pseudo-account, not the caller's own account — the IAM resource must be `arn:aws:bedrock-agentcore:<region>:aws:browser/aws.browser.v1` (same pattern as Web Search's `arn:...:aws:tool/web-search.v1`). Scoping it to the caller's account ID instead produces an opaque `AccessDeniedException` on `StartBrowserSession`.
- **Stability AI image models are `us-west-2`-only**: as of July 2026, Stability's Stable Image Ultra/Core/SD3.5 Large exist as on-demand Bedrock foundation models only in `us-west-2` — confirmed absent from `ap-southeast-2` (where this backend otherwise runs), `us-east-1`, and `eu-west-1` via `aws bedrock list-foundation-models --by-provider stability-ai --region <region>`. Nova Canvas/Titan Image Generator (the only image models `ap-southeast-2`/`us-east-1`/`eu-west-1` do offer) are Legacy, EOL 2026-09-30 — don't build on them. `backend/src/lib/imageGen/providers/bedrockStability.ts` uses its own `us-west-2`-pinned `BedrockRuntimeClient`, a plain cross-region `InvokeModel` call (image models have no cross-region inference profile equivalent to the `global.*` one above).

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
