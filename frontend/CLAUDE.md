# Frontend

See root `CLAUDE.md` for commands, architecture overview, and key gotchas.

## Layout

CSS grid (`display: grid`, columns `48px var(--sidebar-w, 260px) 1fr`, rows `45px 1fr`). Variables: `$activity-bar-w: 48px`, `$header-h: 45px`, `$sidebar-w: 260px`. The global header spans both LHS columns (`grid-column: 1 / 3`). Sidebar width is resizable (drag `.sidebar-resizer`, clamped 180–480 px). Mobile (`max-width: 720px`) switches to `display: flex; flex-direction: column` and the global header + activity bar + sidebar become a fixed slide-in drawer toggled by `.sidebar-open` — the chat header is the only chrome row on a phone, and it grows its own "+ new chat" button (`.btn-header-new-chat`, mobile-only like `.btn-hamburger`) since the global header's is inside the drawer.

`.layout` is `position: fixed` with `height: var(--app-h, 100dvh)`; `lib/viewportHeight.ts` keeps `--app-h` in sync with `window.visualViewport.height` and resets `window.scrollTo(0, 0)`, so an iOS keyboard can't scroll the app chrome off-screen. `index.html`'s viewport meta carries `interactive-widget=resizes-content` for the Android Chrome equivalent.

## Where a control lives

Why per-send controls were moved out of the chat header: `docs/adr/0028-composer-owns-per-send-controls.md`. Three surfaces, split by what the control is *about*:

- **`.composer-toolbar`** (in `ChatView.tsx`, above the textarea) — decisions about the message you're about to send: model select, research depth, project picker (drafts only — a native `<select>` that collapses to a folder icon via `.project-picker-wrap.is-empty` while nothing is filed, and spends width on the ellipsised name only once a project is chosen), Private quick-toggle. Scrolls horizontally rather than wrapping. Controls use `.composer-select` (pill-shaped); `.model-select` is the squarer variant still used inside dialogs and panels.
- **`.chat-header`** — identity + navigation only: hamburger (mobile), title, project chip (width-capped and ellipsised — 180px desktop, 120px mobile), "+ new chat" (mobile), details cog.
- **`ChatDetailsDialog` / `ProjectDetailsDialog`** — everything item-scoped and infrequent, unchanged.

## Frontend structure

```
frontend/src/
  api/http.ts             — REST client; types: Model/ModelCapabilities/ModelSettings/UserPreferences/UserMemory/Project/ProjectMemory/ProjectFile; migrateSettings(); requestUpload/uploadToS3; project + file API methods
  api/ws.ts               — WebSocket client (connect/send/cancelMessage/event routing); routes 'warning' frame → error toast
  store/chatStore.ts      — Zustand store; persists lastModel, sidebarWidth, activePanel, userPreferences, models; projects[] slice
  lib/viewportHeight.ts   — keeps --app-h in sync with visualViewport so a mobile keyboard can't push the chrome off-screen
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
    ChatDetailsDialog.tsx  — two tabs on a saved chat (Settings, default open; Info — title/summary/topics), no tabs on a /c/new draft (Info has nothing to show pre-send); same component either way (see below)
    ProjectDetailsDialog.tsx — description, instructions, project memory toggle, default model, ToolsPanel, ModelTuningPanel
    ChatView.tsx           — main chat pane, URL-driven (/c/new or /c/:chatId); project chip in header when chat belongs to a project; header cog opens ChatDetailsDialog; model/depth/project/"Private" live in the composer toolbar (see "Where a control lives")/tint/footer
    ToolsPanel.tsx          — what the model may call out to: web search, browser core/extended, memory, search history, inject-timestamp (all always shown, none capability-gated)
    ModelTuningPanel.tsx    — how the model reasons/writes: answer length, thinking effort (capability-gated), temperature (capability-gated). No Top P control — dropped as rarely-worth-tuning clutter.
    StepBlocks.tsx         — ThinkingBlock / ToolCallPill (+ search-result cards, sanitizeUrl): how one step of a turn renders. Shared by MessageBubble and ResearchPanel so Deep Research progress looks identical to any other tool use
    ResearchPanel.tsx      — Deep Research plan-approval gate + live progress (recon steps, per-researcher step lists, findings, phase status line)
    MessageBubble.tsx      — markdown + syntax-highlighted code blocks (PrismLight) with copy button; thinking, tool pills, per-message metadata; sibling nav, re-run, edit, fork, copy, delete actions
    Toaster.tsx            — stacked toast notifications (bottom-center), auto-dismiss 3s
  env.ts                  — VITE_* env var access
```

React Router v6: `/` → `/c/new`, `/c/:chatId` for chats, `/p/:projectId` for project views. Navigation is URL-driven — `useParams` replaces a global active-chat store entry.

Persisted Zustand state (localStorage via `persist` middleware): `lastModel`, `sidebarWidth`, `activePanel`, `userPreferences`, `models`. Everything else is ephemeral. `models` is cached so the pickers render populated on first paint; `App.tsx` revalidates it via `api.listModels()` outside the `setLoading` gate rather than inside the blocking `Promise.all`.

## ModelSettings flags

`ModelSettings.webSearchEnabled` defaults to `true`; when `false`, `bedrock.ts` omits web tools from the tool list. `ModelSettings.webSearchProvider` (`'jina' | 'agentcore'`, default `jina`) selects which backend powers the `web_search` tool. `ModelSettings.browserCoreEnabled` (default `true`) gates `take_screenshot`/`get_rendered_page`; `ModelSettings.browserExtendedEnabled` (default `false`) gates the scripted `browse_web` tool. `ModelSettings.memoryEnabled` defaults to `true`; when `false`, the `manage_memory` tool is also omitted. `ModelSettings.searchEnabled` defaults to `true`; when `false`, the `search_history` tool is omitted from organic tool choice — but the explicit Search entry point still forces it in. `ModelSettings.imageGenerationEnabled` defaults to `false` — unlike every other flag above, this one is opt-in rather than opt-out, since each `generate_image` call costs money; `migrateSettings()` carries the user's explicit choice forward across a model switch rather than defaulting it on.

Per-assistant-turn `thinkingEffort` and `webSearchEnabled` are persisted in DynamoDB and surfaced in the bubble metadata line.

## Stale model migration notice

If a chat's stored model was retired from the backend's `MODELS` registry, the backend already swapped it to the current default and reports it once via `Chat.modelMigratedFrom` (see `backend/CLAUDE.md`). `ChatView.tsx` shows this as a dismissible `.error-banner.warning` banner (the existing `.error-banner` shape with an amber modifier instead of a whole new banner style) right below the header; dismissing calls `clearModelMigrationNotice(chatId)`, which just clears the field locally — the backend never re-sends it once the chat's `model` is valid, so there's nothing to persist.

## Chat details dialog & the settings surfaces

Why item-scoped settings were consolidated into one dialog per item instead of a header pill/popover/sidebar-tabs split: `docs/adr/0009-consolidate-item-scoped-settings-into-one-dialog.md`. Rule of thumb going forward: **defaults are a page** (`PreferencesPanel.tsx`, reached via the left rail — nothing item-scoped belongs there), **item-scoped settings are a dialog** (`ChatDetailsDialog.tsx` / `ProjectDetailsDialog.tsx`, reached from a cog next to the item).

`ChatDetailsDialog.tsx` is the *same component* for a `/c/new` draft and a saved chat — it's handed either the draft state (`draftModelSettings`/`draftSystemPrompt`/`draftSensitive`/`draftEphemeral` in `ChatView.tsx`) or the saved chat's fields, and `ChatView.tsx` decides which write path a toggle takes (local state pre-send vs. `api.updateChatFlags`/`updateChatSettings`/`updateSystemPrompt` post-send). The header cog (`title="Chat details"`) is present in both states.

A saved chat's dialog splits into two tabs (`.prefs-tabs`): **Settings** (default open — Privacy, custom instructions, `ToolsPanel.tsx`, `ModelTuningPanel.tsx`, in that order) and **Info** (title, summary, topic chips). A draft skips the tab bar and shows Settings content directly (nothing to put in Info yet).

`ProjectDetailsDialog.tsx` is the single editor for a project's `description`/`instructions`/`memoryEnabled`, and shares `ToolsPanel`/`ModelTuningPanel` with the chat dialog. `PrefControls.tsx` (`ToggleRow`, `EffortRow`) is the shared row shape all three settings surfaces render through.

## Sensitive & ephemeral chats

Two independent per-chat flags (`Chat.sensitive`, `Chat.ephemeral`+`expiresAt`) — why they're separate, what each excludes: `docs/adr/0008-sensitive-and-ephemeral-are-independent-flags.md` and "Sensitive & ephemeral chats" in `backend/CLAUDE.md`. `ChatDetailsDialog.tsx` exposes them as two independent toggles (draft or saved, see above). For the common case of wanting both at once, `ChatView.tsx`'s composer toolbar also has a one-click "Private" button (`.btn-private-toggle`, always visible next to the model select) that sets/clears both flags together in a single `api.updateChatFlags` call (`handleSetPrivate`) — a shortcut alongside the dialog's granular control, not a replacement for it. Every flag change refetches the chat's DTO afterward (`patchChat`) rather than hand-computing `expiresAt`, since the server owns `ttl` and its fresh-on-enable semantics.

Sensitive chats are returned by `GET /api/chats` like any other chat (no backend exclusion), so they live in the normal Zustand `chats` array — no separate store slot, no fallback fetch. Visibility is purely a frontend filter: `ChatListFilter.tsx` is a shared popover (used by both `ChatsPanel` and `ProjectView`) with a "show sensitive chats" checkbox (default off) folded together with the pre-existing "show project chats" checkbox; `applyChatListFilter()` is the one shared predicate both panels apply, so they can't drift. Revealed sensitive chats render with an italic title (`.chat-item.sensitive`) to set them apart subtly — no separate section/list. The chat header itself never shows a sensitive chat's title (only a discreet chip — "Sensitive", or "Private" once auto-delete is also on, so it never contradicts the header button's own label); the real title only ever appears in the LHS, gated by the same filter. Visuals: `.chat-view--private` violet tint (header/messages/input area) and a footer line showing `expiresAt` when `ephemeral`.

## Env vars

Set by `deploy.sh` at build time from Terraform outputs. For local dev, copy `frontend/.deploy-env` (written after each deploy) into your shell or a `.env` file:

```
VITE_API_BASE_URL, VITE_WS_URL, VITE_COGNITO_USER_POOL_ID, VITE_COGNITO_CLIENT_ID,
VITE_COGNITO_DOMAIN, VITE_APP_URL
```
