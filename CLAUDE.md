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
```

### Frontend

```bash
npm --prefix frontend run build     # tsc + vite build → frontend/dist/
npm --prefix frontend run dev       # local dev server (needs VITE_* env vars — see frontend/.deploy-env after a deploy)
```

The frontend has no test suite. Type-checking is part of `npm run build` (tsc runs first).

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
- **Streaming**: client sends `{ action: 'sendMessage', chatId, content, model, systemPrompt, modelSettings }` over WebSocket. `ws/sendMessage.ts` persists the user message, calls Bedrock `ConverseStream` in an agentic loop (up to 5 rounds for tool use), pushes event frames back via `ApiGatewayManagementApi.postToConnection`.

### DynamoDB single-table

Table `chatrock-prod` with PK/SK:
- Chat: `PK=USER#<sub>` / `SK=CHAT#<chatId>` — title, model, systemPrompt, createdAt, updatedAt
- Message: `PK=CHAT#<chatId>` / `SK=MSG#<iso-timestamp>#<msgId>` — role, content, model, createdAt
- WS connection: `PK=CONN#<connId>` / `SK=CONN#<connId>` — userSub, TTL

Every CRUD handler derives `sub` from the JWT claims — never from client input — so users only ever touch their own partition.

### Backend structure

```
backend/src/
  config/models.ts      — model registry with capabilities (temperature/topP/topK/thinking)
  lib/bedrock.ts        — ConverseStream wrapper + agentic tool-use loop
  lib/dynamo.ts         — DynamoDB access layer (all table operations)
  lib/tools.ts          — Bedrock tool specs + Jina web_search / web_fetch executor
  http/                 — one file per HTTP API route group (chats, messages, models)
  ws/sendMessage.ts     — the core streaming handler (the most complex file)
  ws/authorizer.ts      — WebSocket Lambda authorizer
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
| `titleUpdated` | `chatId`, `title` |
| `error` | `message` |

### Frontend structure

```
frontend/src/
  api/http.ts           — REST client + Model/ModelCapabilities/ModelSettings types + migrateSettings()
  api/ws.ts             — WebSocket client (connect/send/event routing)
  store/chatStore.ts    — Zustand store (messages, streamingMsg with toolCalls/thinking, lastModel persisted)
  components/
    ChatView.tsx         — main chat pane, URL-driven (/c/new or /c/:chatId)
    ModelSettingsPanel.tsx — dynamic settings panel rendered from model capabilities
    MessageBubble.tsx    — renders thinking blocks, tool call pills, markdown (react-markdown + remark-gfm)
    Sidebar.tsx          — chat list with navigate(), retitle wand
  env.ts                — VITE_* env var access
```

React Router v6: `/` → `/c/new`, `/c/:chatId` for existing chats. Navigation is URL-driven — `useParams` replaces a global active-chat store entry.

`lastModel` is the only Zustand state persisted to localStorage. Everything else is ephemeral.

### Frontend env vars

Set by `deploy.sh` at build time from Terraform outputs. For local dev, copy `frontend/.deploy-env` (written after each deploy) into your shell or a `.env` file:

```
VITE_API_BASE_URL, VITE_WS_URL, VITE_COGNITO_USER_POOL_ID, VITE_COGNITO_CLIENT_ID,
VITE_COGNITO_DOMAIN, VITE_APP_URL
```

### Jina web search / fetch

`lib/tools.ts` implements `web_search` (via `s.jina.ai/{query}` with `JINA_API_KEY`) and `web_fetch` (via `r.jina.ai/{url}`, no key). The API key is set in `terraform/terraform.tfvars` as `jina_api_key` and injected into Lambda env. If empty, the tools still appear in the tool spec but requests will 401.

## Key gotchas

- **Inference profiles**: models use `global.*` cross-region inference profiles (`global.anthropic.claude-opus-4-8` etc.), not direct model IDs. Verify with `aws bedrock list-inference-profiles --region ap-southeast-2 --type-equals SYSTEM_DEFINED`.
- **Thinking API**: adaptive thinking (`type=adaptive` + `output_config.effort`) is what Opus 4.8 and Sonnet 4.6 expect — not `type=enabled`/`budget_tokens`. Temperature/topP must be absent when thinking is active.
- **WS authorizer**: TTL caching (`authorizer_result_ttl_in_seconds`) is not valid for WebSocket APIs — omit it.
- **`cd` in Bash**: avoid `cd` in commands; use `--prefix` or absolute paths to keep auto-approval working.
- **Screenshots**: save to `.screenshots/YYYY-MM-DD-description.jpg`.
