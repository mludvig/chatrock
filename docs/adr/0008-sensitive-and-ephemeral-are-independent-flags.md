# 8. Sensitive and ephemeral are independent chat flags, not one "private" flag

## Status

Accepted

## Context

Two distinct privacy needs came up for chats: "never let this chat's content leak into memory/search/summaries" and "auto-delete this chat after a while." The initial framing treated both as one concept — "private."

Alternatives considered:

1. **One combined `private` boolean** driving both memory/search exclusion and auto-delete together.
2. **Two independent booleans** — `sensitive` (excluded from user-fact memory, project-fact memory, and the summary `search_history` indexes) and `ephemeral`+`ttl` (auto-deletes via the cascade-delete path, ADR 0006) — combinable in any of the four states.

## Decision

Option 2. Real scenarios split the two and can't be expressed by a single flag: a sensitive chat someone later decides is worth keeping forever (sensitive, not ephemeral); a throwaway non-sensitive chat that's fine to contribute to memory/search before it auto-deletes (ephemeral, not sensitive). Both flags remain valid in any combination, including together inside a project — a sensitive project chat still *reads* project instructions/files/memory in (nothing leaks, since nothing flows out of the project from it), it just never writes facts back out.

## Consequences

- Every place that could leak chat content outward — user-fact memory, project-fact memory, `search_history`'s summary index — must independently check `sensitive` rather than one combined flag; more call sites to get right (enumerated explicitly in `backend/CLAUDE.md`'s "Sensitive & ephemeral chats" section: enrichment skip, `resummarize` 400, search-corpus exclusion).
- Marginally more UI surface than a single toggle, mitigated by a one-click "Private" shortcut (`ChatView.tsx`'s `.btn-private-toggle`) that sets both flags at once for the common case, alongside the dialog's independent per-flag control for the uncommon cases.
- Title generation is deliberately *exempt* from the `sensitive` exclusion (the title lives on the chat record itself and is a frontend display-filter concern, not a content-leak concern) — a distinction easy to get backwards if "sensitive" is assumed to mean "hide from everything."
