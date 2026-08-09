# 14. Per-chat Memory toggle moves into the chat dialog's Privacy section

## Status

Accepted

## Context

`ModelSettings.memoryEnabled` (the per-chat "Memory" toggle) lived in `ToolsPanel.tsx`'s "Tools" section, right beside web search/browser/image-generation toggles — capabilities the model reaches for mid-turn. But Memory isn't a tool capability in the same sense: it controls whether this chat's saved facts are *read into* its system prompt and whether new facts get *written out* from it — a privacy-adjacent concern, not a tool-availability one. Sitting in "Tools" made it easy to conflate with `Chat.sensitive` (`docs/adr/0008-sensitive-and-ephemeral-are-independent-flags.md`), which also gates memory writes but never reads — user feedback was exactly this confusion ("I suppose Sensitive means memory won't be updated but what does the Memory toggle do?").

`ToolsPanel` is shared between `ChatDetailsDialog.tsx` and `ProjectDetailsDialog.tsx`. Only the chat dialog has a Sensitive/Auto-delete Privacy section to relocate Memory next to — projects have no equivalent flag, so there's nothing there for it to be confused with.

## Decision

Add a `hideMemory` prop to `ToolsPanel` (default `false`); `ChatDetailsDialog.tsx` passes `hideMemory` and renders the same toggle itself, as the fourth row in its existing Privacy block, with an expanded tooltip that explicitly cross-references Sensitive ("Independent of Sensitive, which only ever blocks writes"). Sensitive's own tooltip was expanded to state the reverse (reads/injection are unaffected by it). `ProjectDetailsDialog.tsx` is untouched — it still renders the unmodified `ToolsPanel` with Memory in Tools, since it has no Privacy section for the toggle to be confused against.

## Consequences

- One extra prop (`hideMemory`) on `ToolsPanel` rather than forking it into two components — the row markup and `set()` logic stay in one place conceptually, just gated.
- The chat dialog's Privacy section now fully answers "what happens to my chat's data" in one place: Sensitive (blocks shared writes), Auto-delete (TTL), Memory (read/write for this chat specifically), Show token stats.
- Project-scoped chats still inherit `memoryEnabled` from `ModelSettings` same as before; only the *chat* dialog's presentation changed, not the underlying flag or its defaults.
