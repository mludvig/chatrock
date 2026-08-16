# 0024: Research dossier as a project file

## Status

Accepted

## Context

A completed Deep Research run's condensed answer lands in the chat as a normal assistant
turn, but the raw investigation — every finding's summary and sources, the plan, the gaps
deliberately not pursued — is otherwise discarded. A follow-up question on the same topic
would re-research from scratch. Chatrock already has a durable, progressively-disclosed
document store built for exactly this shape: project files (`microLabel` + `summary` +
manifest line + `read_project_file`/`search_history`).

## Decision

`report.ts`'s `Report` state, after persisting the answer as a turn, writes a markdown
dossier (final report, plan, merged findings with source URLs, gaps not pursued) as a
project file with `inclusion: 'auto'`. If the chat is not already in a project, one is
created (named from the truncated research question) and the chat is moved into it via the
same `updateChatProject` + `summarizeChatById` + `enrichProjectFactsByChatId` sequence
`http/chats.ts`'s `PATCH .../projectId` path uses for a user-initiated move — so a Deep
Research run has the identical side effects a manual "move into project" would.

The dossier is built from `ReportInput`'s merged `findings: Finding[]` and `gapsNotPursued`
rather than each wave's raw per-researcher output or each individual supervisor assessment,
even though the original design sketch asked for the latter. Only the running-merged total
flows through `AssessResult`/`ReportInput` today (see `research/types.ts`); capturing full
per-wave history would mean extending the `RUN#` row to accumulate it on every `Assess`
call, for a document that's a fallback read path, not the primary product surface.

## Consequences

- Every Deep Research run adds a project unless the chat already has one — accepted
  projects-list clutter, mitigated by the run's completion announcing it and by the
  existing move/delete UI.
- The dossier is coarser than a full per-wave transcript: a follow-up question can be
  answered from the merged findings and final report, but not from an individual
  researcher's discarded reasoning or a specific wave's assessment rationale. If that turns
  out to matter in practice, the fix is threading a fuller history through `AssessResult`,
  not changing where the dossier is stored.
- Sensitive chats need a different path entirely (no project, no dossier) — carved out as a
  separate follow-up rather than an `if` in this handler, so the exception stays visible at
  its own call site instead of buried in dossier-writing logic.
