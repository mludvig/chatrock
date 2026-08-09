# 15. Privacy toggle labels are behavior-first; `sensitive` stays unrenamed

## Status

Accepted

## Context

Users found "Sensitive" and "Memory" confusing side by side — it wasn't obvious that Sensitive only ever blocks *writes* (new facts, summary/topics), never reads, and that it's meaningless when Memory itself is off. Re-reading `backend/src/ws/sendMessage.ts`'s post-turn enrichment also surfaced a gap the old tooltips didn't capture: chat summary/topics regeneration (which feeds `search_history`'s corpus) is gated by `memoryEnabled && !sensitive`, the same nested condition as memory writes — not by `sensitive` alone. So turning memory off also silently stops a chat's summary from staying current for search, independent of Sensitive.

Renaming or splitting the underlying `sensitive` flag (DynamoDB attribute, `Chat.sensitive`, `.chat-item.sensitive` CSS, `ChatListFilter`, `buildSearchHistoryCorpus`'s exclusion) was considered — it's a one-off dump/rename/push, technically cheap. But there's no real use case for splitting it into separate memory/search concerns (every caller that checks it wants "exclude this chat's content from being written anywhere shared"), and renaming buys little once the labels and this ADR already document the mapping — it's blast radius for no behavioral gain.

## Decision

- Relabel the two toggles behavior-first: "Use memory" (`ModelSettings.memoryEnabled`, unchanged) and "Update memory" (displays `!sensitive` — ON is the normal/writes-allowed state — while the click handler and stored value are still `sensitive` unchanged). Reorder Privacy to Use memory / Update memory / Auto-delete.
- Move "Show token stats" out of the Privacy block to the bottom of the Settings tab, after `ModelTuningPanel` — it's not a privacy setting.
- Add `frontend/src/lib/privacyDescription.ts`'s `describeChatPrivacy()` as the single source of truth for what the three toggles actually do in combination (read vs. write vs. summary/search staleness), reused by `ChatDetailsDialog`'s inline summary line and `ChatView`'s header chip tooltip / footer text, so the two surfaces can't drift into describing different behavior.
- Keep `sensitive` as the internal name everywhere outside the display layer — DynamoDB attribute, backend logic, CSS class, `ChatListFilter`. This ADR is the map from label to flag.

## Consequences

- Toggle labels now describe the user-visible effect ("Use"/"Update") instead of a flag name ("Sensitive") that only made sense once you knew what it excluded.
- One inversion point to remember: "Update memory" ON == `sensitive === false`. Anyone reading `ChatDetailsDialog.tsx`'s Update-memory row or `ChatView.tsx`'s private-chip/footer should check this ADR before assuming the toggle's displayed state matches the stored flag.
- `describeChatPrivacy()` centralizes the read/write/summary gating matrix in one place instead of three independently-hand-written strings (dialog summary, header chip tooltip, footer) — the summary-staleness nuance discovered this round only needed fixing once.
- No backend, DynamoDB, or `sensitive`-name changes — zero migration risk, at the cost of the flag name never quite matching its label going forward.
