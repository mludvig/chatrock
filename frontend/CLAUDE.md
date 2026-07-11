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
    ProjectsPanel.tsx      — project list: create (inline), rename, delete; click → /p/:projectId
    ProjectView.tsx        — project detail (/p/:projectId): chats list (with summary), file upload/inclusion/delete, project memory, rename; 'New chat' creates chat in project
    MemoryPanel.tsx        — user memories grouped by category; delete; refreshes on memoryRefreshTick
    PreferencesPanel.tsx   — two tabs: Defaults (UserPreferences, 800ms debounce) and This chat (per-chat system prompt + ModelSettings)
    ChatView.tsx           — main chat pane, URL-driven (/c/new or /c/:chatId); project chip in header when chat belongs to a project; private-chat toggle/tint/footer (see below)
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

## Private chats

Created via a "Private" toggle in `ChatView.tsx`'s header, shown only for `/c/new`; passes `isPrivate: true` to `api.createChat`. Backend excludes them from `GET /api/chats`, so they're deliberately never pushed into the store's `chats` array (`ChatsPanel` renders exactly that array — pushing to it would surface a "private" chat in the list). Instead they live in `chatStore.ts`'s `privateChats: Record<chatId, Chat>` slot (not part of `persist`'s `partialize`, so it doesn't survive a reload — a reload re-fetches via `GET /api/chats/{chatId}` on demand). `ChatView.tsx` resolves `activeChat = chats.find(...) ?? privateChats[chatId]`, which is why every other piece of chat logic (already written against `activeChat`) needed no changes to support private chats. See "Chat deletion & temporary/private chats" in `backend/CLAUDE.md` for the full backend design (TTL, cascade delete, memory/search exclusion).

## Env vars

Set by `deploy.sh` at build time from Terraform outputs. For local dev, copy `frontend/.deploy-env` (written after each deploy) into your shell or a `.env` file:

```
VITE_API_BASE_URL, VITE_WS_URL, VITE_COGNITO_USER_POOL_ID, VITE_COGNITO_CLIENT_ID,
VITE_COGNITO_DOMAIN, VITE_APP_URL
```
