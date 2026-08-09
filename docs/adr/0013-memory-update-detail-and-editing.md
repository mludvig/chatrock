# 13. Carry structured detail on memory-update toasts; add PATCH for user memory

## Status

Accepted

## Context

The `memoryUpdated` WS event previously carried only a bare `count`, so the toast could only ever say "Memory updated" or "Memory updated (N new facts)" — no indication of what changed. Meanwhile `manage_memory`/`manage_project_memory` tool calls already render a detailed card (op/category/text) in `MessageBubble.tsx`'s tool-pill, and `manage_project_memory` had a pre-existing bug where it never fired `memoryChanged` at all (only `manage_memory` did), so project-memory tool writes never toasted.

Separately, project memory already supported inline edit (`ProjectView.tsx` + `PATCH /api/projects/{projectId}/memory/{memId}`), but user/global memory (`MemoryPanel.tsx`) only supported delete — an asymmetry with no reason behind it.

## Decision

- Extend `StreamChunk`'s `memoryChanged` variant (`backend/src/lib/llm/types.ts`) with `scope`/`operation`/`category`/`text`, and fix `loop.ts` to emit it for both `manage_memory` and `manage_project_memory`.
- Extend the `memoryUpdated` WS frame with an `items?: MemoryUpdateItem[]` array — one item for an explicit tool call, zero-or-more for passive multi-item enrichment (`ws/sendMessage.ts` collects `passiveMemoryItems` from the reconciled ADD/UPDATE/DELETE ops).
- Frontend `Toaster.tsx` renders the same `.memory-update-card` markup `MessageBubble.tsx` already uses for the tool-pill, so the toast and the inline tool-call rendering never visually diverge — one card component, two call sites.
- Add `updateUserMemory` (`dynamo.ts`) + `PATCH /api/memory/{memId}` (`http/memory.ts`), mirroring the existing project-memory PATCH route exactly, and give `MemoryPanel.tsx` the same click-to-edit pattern `ProjectView.tsx` already has for project memories.

## Consequences

- The `manage_project_memory` toast-firing bug is fixed as a side effect of this change, not a separate fix.
- `MemoryUpdateItem` is shared shape (`frontend/src/api/ws.ts`) between the explicit-tool-call path and the passive-enrichment path — no separate types to keep in sync.
- User and project memory now have identical edit/delete capability; no remaining asymmetry between the two stores' frontend surfaces.
