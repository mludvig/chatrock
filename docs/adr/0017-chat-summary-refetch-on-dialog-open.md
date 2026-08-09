# 17. Chat summary/topics: refetch-on-open instead of a live push, made editable

## Status

Accepted

## Context

`ChatDetailsDialog.tsx`'s Info tab showed a chat's `summary`/`topics` as empty even for chats that clearly had one (visible in `ProjectView.tsx`'s own chat list). Root cause: the global Zustand `chats` store is populated once at login (`App.tsx`'s single `listChats()` call) and never patched afterward for these two fields. `title` has a dedicated `titleUpdated` WS push and `sensitive`/`ephemeral` are explicitly refetched after their toggle actions (`ChatView.tsx`'s `handleToggleFlag`), but `summary`/`topics` — written by post-turn enrichment (`ws/sendMessage.ts`, `summarizeChat()`) well after the `done` WS frame — have no equivalent. `ProjectView.tsx`'s list looked fresh only because it does its own `api.getProject()` fetch, independent of the global store.

## Decision

- `ChatView.tsx` refetches the single chat's DTO (`api.getChat(chatId)`) when the Chat details dialog opens and patches `summary`/`topics` into the store, rather than adding a new WS push event. Chosen over a `summaryUpdated` push because this is the only place the fields are read today — a live push would be unused plumbing until a second consumer appears.
- Summary and topics are now editable in the Info tab (textarea + comma-separated topics input, both committing on blur via the existing `api.updateChatSummary` PATCH), reusing the same optimistic-update/revert-on-failure pattern as `handleToggleFlag`.

## Consequences

- One extra GET per dialog open for a saved chat — negligible cost, keeps the fix scoped to where it's needed.
- If a second surface ever needs live summary/topics updates (e.g. showing them in the header while streaming), revisit adding a WS push then rather than pre-building it now.
- Manual edits to summary/topics can be overwritten by the next turn's `summarizeChat()` pass, since it merges into "whatever summary/topics this chat already has" — same tradeoff as manual memory edits already accepted in `docs/adr/0013-memory-update-detail-and-editing.md`.
