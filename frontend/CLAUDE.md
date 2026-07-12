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
    App.tsx                — root layout: global header (brand + Search box + New chat + New project btns), ActivityBar, Sidebar, ChatView; routes /p/:projectId → ProjectView
    ActivityBar.tsx        — 48 px icon rail; four panel-switch buttons (Chats/Projects/Memory/Preferences) + sign-out
    Sidebar.tsx            — thin container; renders ChatsPanel | ProjectsPanel | MemoryPanel | PreferencesPanel per activePanel
    ChatsPanel.tsx         — chat list: navigate, rename, delete, AI retitle; per-item project chip + move-to-project dropdown
    ChatListFilter.tsx     — shared popover (ChatsPanel + ProjectView): show-sensitive / show-project-chats toggles + applyChatListFilter()
    ProjectsPanel.tsx      — project list: create (inline, triggered by its own "+" or the global "New project" btn via newProjectTick), rename, delete; click → /p/:projectId
    ProjectView.tsx        — project detail (/p/:projectId): chats list (with summary), file upload/inclusion/delete, project memory, rename, gear → ProjectDetailsDialog; 'New chat' is the one entry point for a project-scoped chat
    MemoryPanel.tsx        — user memories grouped by category; delete; refreshes on memoryRefreshTick
    PreferencesPanel.tsx   — Defaults only (UserPreferences, 800ms debounce), no tabs — per-chat/per-project overrides live in their own dialogs (see below)
    Dialog.tsx             — shared modal shell (centered card on desktop, full-width bottom sheet on mobile); Esc/backdrop-click to close
    PrefControls.tsx       — ToggleRow / EffortRow — shared row primitives used by PreferencesPanel, ChatDetailsDialog, ProjectDetailsDialog so a toggle looks identical everywhere
    ChatDetailsDialog.tsx  — rename, Sensitive/Auto-delete, per-chat custom instructions + ModelSettingsPanel, summary/topics; same component for a /c/new draft and a saved chat (see below)
    ProjectDetailsDialog.tsx — description, instructions, default model + ModelSettingsPanel, project memory toggle
    ChatView.tsx           — main chat pane, URL-driven (/c/new or /c/:chatId); project chip in header when chat belongs to a project; "Private" quick-toggle + model select + cog (opens ChatDetailsDialog)/tint/footer (see below)
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

## Chat details dialog & the settings surfaces

Per-chat and per-project overrides live in one modal shell (`Dialog.tsx`) instead of being spread across a header pill, a header cog popover, and sidebar sub-tabs (the pre-consolidation shape — see git history if archaeology is ever needed). The rule of thumb going forward: **defaults are a page** (`PreferencesPanel.tsx`, reached via the left rail — nothing item-scoped belongs there), **item-scoped settings are a dialog** (`ChatDetailsDialog.tsx` / `ProjectDetailsDialog.tsx`, reached from a cog next to the item).

`ChatDetailsDialog.tsx` is the *same component* for a `/c/new` draft and a saved chat — it's handed either the draft state (`draftModelSettings`/`draftSystemPrompt`/`draftSensitive`/`draftEphemeral` in `ChatView.tsx`) or the saved chat's fields, and `ChatView.tsx` decides which write path a toggle takes (local state pre-send vs. `api.updateChatFlags`/`updateChatSettings`/`updateSystemPrompt` post-send). The header cog (`title="Chat details"`) is present in both states — there's no separate pre-send "Private" pill that gets swapped out once the chat exists.

`ProjectDetailsDialog.tsx` merges what used to be two independently-editable copies of `description`/`instructions`/`memoryEnabled` (one in the old Preferences "This project" tab, one inline on the project page) into a single editor — that duplication was a real bug (two live editors racing the same DynamoDB field), not just visual clutter.

`PrefControls.tsx` (`ToggleRow`, `EffortRow`) is the shared row shape all three settings surfaces render through, so a toggle looks and behaves identically whether it's in Defaults, a chat's dialog, or a project's dialog.

## Sensitive & ephemeral chats

Two independent per-chat flags (`Chat.sensitive`, `Chat.ephemeral`+`expiresAt`) — see "Sensitive & ephemeral chats" in `backend/CLAUDE.md` for the full design (why they're separate, what each excludes). `ChatDetailsDialog.tsx` exposes them as two independent toggles (draft or saved, see above). For the common case of wanting both at once, `ChatView.tsx`'s header also has a one-click "Private" button (`.btn-private-toggle`, always visible next to the model select) that sets/clears both flags together in a single `api.updateChatFlags` call (`handleSetPrivate`) — a shortcut alongside the dialog's granular control, not a replacement for it. Every flag change refetches the chat's DTO afterward (`patchChat`) rather than hand-computing `expiresAt`, since the server owns `ttl` and its fresh-on-enable semantics.

Sensitive chats are returned by `GET /api/chats` like any other chat (no backend exclusion), so they live in the normal Zustand `chats` array — no separate store slot, no fallback fetch. Visibility is purely a frontend filter: `ChatListFilter.tsx` is a shared popover (used by both `ChatsPanel` and `ProjectView`) with a "show sensitive chats" checkbox (default off) folded together with the pre-existing "show project chats" checkbox; `applyChatListFilter()` is the one shared predicate both panels apply, so they can't drift. Revealed sensitive chats render with an italic title (`.chat-item.sensitive`) to set them apart subtly — no separate section/list. The chat header itself never shows a sensitive chat's title (only a discreet chip — "Sensitive", or "Private" once auto-delete is also on, so it never contradicts the header button's own label); the real title only ever appears in the LHS, gated by the same filter. Visuals: `.chat-view--private` violet tint (header/messages/input area) and a footer line showing `expiresAt` when `ephemeral`.

## Env vars

Set by `deploy.sh` at build time from Terraform outputs. For local dev, copy `frontend/.deploy-env` (written after each deploy) into your shell or a `.env` file:

```
VITE_API_BASE_URL, VITE_WS_URL, VITE_COGNITO_USER_POOL_ID, VITE_COGNITO_CLIENT_ID,
VITE_COGNITO_DOMAIN, VITE_APP_URL
```
