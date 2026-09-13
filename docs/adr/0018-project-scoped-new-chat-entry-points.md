# 18. Project-scoped "New chat" entry points

## Status

Superseded by [ADR 0045](0045-simple-navigation-and-project-drafts.md): all entry points now open project-aware drafts and persist on first send.

## Context

The global header "+" button always created an unfiled chat (`navigate('/c/new')`), even when the user was already viewing a project dashboard or a chat that belonged to one — the only way to start a chat inside a project was `ProjectView.tsx`'s own "New chat" button, which meant leaving whatever you were doing to go find it. The sidebar's project tree (`ProjectsPanel.tsx`) also had no "+" affordance on a project row — only rename/delete.

## Decision

- The header "+" reuses `App.tsx`'s existing `contextProjectId` (already computed for the search-scope toggle: the open project dashboard, or the current chat's `projectId`) and navigates to `/c/new?project=<id>` instead of bare `/c/new` when set. `ChatView.tsx` reads `?project=` in the same effect that resets `draftSensitive`/`draftEphemeral`/`draftProjectId` on `newChatTick`, so it still defaults to unfiled outside any project context.
- A query param was chosen over a Zustand field carrying the target project id — it's naturally scoped to one navigation, needs no reset-after-use bookkeeping, and survives a page reload/back-button the same way the rest of the app's routing does.
- `ProjectsPanel.tsx` gets a "+" button per project row (next to rename/delete) that creates the chat immediately via `api.createChat(..., projectId)` and navigates straight to it — mirroring `ProjectView.tsx`'s existing `handleNewChat`, not the draft-picker flow, since there's no chat-in-progress UI to hand a draft state to from the sidebar.

## Consequences

- Two different "new chat in project" behaviors now coexist by design: the header "+" opens a draft (lets you still pick a different project/model before the first send), the sidebar row "+" and `ProjectView`'s own button create eagerly. Consistent with how each already worked before this change — the header "+" always opened a draft, `ProjectView`'s button always created eagerly.
- No backend change — `POST /api/chats` already accepted `projectId`.
