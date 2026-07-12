# Frontend

See root `CLAUDE.md` for commands, architecture overview, and key gotchas.

## Layout

CSS grid (`display: grid`, columns `48px var(--sidebar-w, 260px) 1fr`, rows `45px 1fr`). Variables: `$activity-bar-w: 48px`, `$header-h: 45px`, `$sidebar-w: 260px`. The global header spans both LHS columns (`grid-column: 1 / 3`). Sidebar width is resizable (drag `.sidebar-resizer`, clamped 180–480 px). Mobile (`max-width: 720px`) switches to `display: flex; flex-direction: column` and the activity bar + sidebar become a fixed slide-in drawer toggled by `.sidebar-open`.

## Frontend structure

```
frontend/src/
  api/http.ts             — REST client; types: Model/ModelCapabilities/ModelSettings/UserPreferences/UserMemory/Project/ProjectMemory/ProjectFile; migrateSettings(); requestUpload/uploadToS3; project + file API methods
  api/ws.ts               — WebSocket client (connect/send/cancelMessage/event routing); routes 'warning' frame → error toast
  store/chatStore.ts      — Zustand store; persists lastModel, sidebarWidth, activePanel, userPreferences; projects[] slice
  lib/toolResults.ts      — shared helpers: parses web_search JSON into SearchResult[], and search_history JSON into SearchHistoryResult[], for cards
  lib/useAsyncAction.ts   — hook: wraps async fn → {run, pending}; errors auto-push to toast store
  components/
    App.tsx                — root layout: global header (brand + Search box + new-chat btn), ActivityBar, Sidebar, ChatView; routes /p/:projectId → ProjectView
    ActivityBar.tsx        — 48 px icon rail; four panel-switch buttons (Chats/Projects/Memory/Preferences) + sign-out
    Sidebar.tsx            — thin container; renders ChatsPanel | ProjectsPanel | MemoryPanel | PreferencesPanel per activePanel
    ChatsPanel.tsx         — chat list: navigate, rename, delete, AI retitle; per-item project chip + move-to-project dropdown
    ChatListFilter.tsx     — shared popover (ChatsPanel + ProjectView): show-sensitive / show-project-chats toggles + applyChatListFilter()
    ProjectsPanel.tsx      — project list: create (inline), rename, delete; click → /p/:projectId
    ProjectView.tsx        — project detail (/p/:projectId): chats list (with summary), file upload/inclusion/delete, project memory, rename; 'New chat' creates chat in project
    MemoryPanel.tsx        — user memories grouped by category; delete; refreshes on memoryRefreshTick
    PreferencesPanel.tsx   — two tabs: Defaults (UserPreferences, 800ms debounce) and This chat (per-chat system prompt + ModelSettings)
    ChatView.tsx           — main chat pane, URL-driven (/c/new or /c/:chatId); project chip in header when chat belongs to a project; Private toggle + cog (sensitive/ephemeral)/tint/footer (see below)
    ModelSettingsPanel.tsx — dynamic settings panel (temperature, topP, thinking effort, web search toggle, memory toggle)
    MessageBubble.tsx      — markdown + syntax-highlighted code blocks (PrismLight) with copy button; thinking, tool pills, per-message metadata; sibling nav, re-run, edit, fork, copy, delete actions
    Toaster.tsx            — stacked toast notifications (bottom-center), auto-dismiss 3s
  env.ts                  — VITE_* env var access
```

React Router v6: `/` → `/c/new`, `/c/:chatId` for chats, `/p/:projectId` for project views. Navigation is URL-driven — `useParams` replaces a global active-chat store entry.

Persisted Zustand state (localStorage via `persist` middleware): `lastModel`, `sidebarWidth`, `activePanel`, `userPreferences`. Everything else is ephemeral.

## ModelSettings flags

`ModelSettings.webSearchEnabled` defaults to `true`; when `false`, `bedrock.ts` omits web tools from the tool list. `ModelSettings.webSearchProvider` (`'jina' | 'agentcore'`, default `jina`) selects which backend powers the `web_search` tool. `ModelSettings.browserCoreEnabled` (default `true`) gates `take_screenshot`/`get_rendered_page`; `ModelSettings.browserExtendedEnabled` (default `false`) gates the scripted `browse_web` tool. `ModelSettings.memoryEnabled` defaults to `true`; when `false`, the `manage_memory` tool is also omitted. `ModelSettings.searchEnabled` defaults to `true`; when `false`, the `search_history` tool is omitted from organic tool choice — but the explicit Search entry point still forces it in.

Per-assistant-turn `thinkingEffort` and `webSearchEnabled` are persisted in DynamoDB and surfaced in the bubble metadata line.

## Stale model migration notice

If a chat's stored model was retired from the backend's `MODELS` registry, the backend already swapped it to the current default and reports it once via `Chat.modelMigratedFrom` (see `backend/CLAUDE.md`). `ChatView.tsx` shows this as a dismissible `.error-banner.warning` banner (the existing `.error-banner` shape with an amber modifier instead of a whole new banner style) right below the header; dismissing calls `clearModelMigrationNotice(chatId)`, which just clears the field locally — the backend never re-sends it once the chat's `model` is valid, so there's nothing to persist.

## Sensitive & ephemeral chats

Two independent per-chat flags (`Chat.sensitive`, `Chat.ephemeral`+`expiresAt`) — see "Sensitive & ephemeral chats" in `backend/CLAUDE.md` for the full design (why they're separate, what each excludes). A "Private" toggle in `ChatView.tsx`'s header, shown only for `/c/new`, sets both together at creation via `api.createChat(..., {sensitive, ephemeral})`. Once a chat exists, a cog button next to the header's model select opens a small popover to toggle each flag independently through `api.updateChatFlags` — every toggle refetches the chat's DTO afterward (`patchChat`) rather than hand-computing `expiresAt`, since the server owns `ttl` and its fresh-on-enable semantics.

Sensitive chats are returned by `GET /api/chats` like any other chat (no backend exclusion), so they live in the normal Zustand `chats` array — no separate store slot, no fallback fetch. Visibility is purely a frontend filter: `ChatListFilter.tsx` is a shared popover (used by both `ChatsPanel` and `ProjectView`) with a "show sensitive chats" checkbox (default off) folded together with the pre-existing "show project chats" checkbox; `applyChatListFilter()` is the one shared predicate both panels apply, so they can't drift. Revealed sensitive chats render with an italic title (`.chat-item.sensitive`) to set them apart subtly — no separate section/list. The chat header itself never shows a sensitive chat's title (only a discreet "Private" chip); the real title only ever appears in the LHS, gated by the same filter. Visuals: `.chat-view--private` violet tint (header/messages/input area) and a footer line showing `expiresAt` when `ephemeral`.

## Env vars

Set by `deploy.sh` at build time from Terraform outputs. For local dev, copy `frontend/.deploy-env` (written after each deploy) into your shell or a `.env` file:

```
VITE_API_BASE_URL, VITE_WS_URL, VITE_COGNITO_USER_POOL_ID, VITE_COGNITO_CLIENT_ID,
VITE_COGNITO_DOMAIN, VITE_APP_URL
```
