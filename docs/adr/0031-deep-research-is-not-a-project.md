# 0031 — A Deep Research run does not create a project

## Status

Accepted. Supersedes `0024-research-dossier-as-a-project-file.md`.

## Context

ADR 0024 had every completed run file a dossier as a project file, creating a project and
moving the chat into it when the chat had none. That made a storage detail (files only
attach to projects) the user's mental model: a research chat became a project chat, so it
dropped out of the chat list's default filter; the project's name duplicated the chat's
title in the sidebar; and deleting the chat left an orphaned, empty project behind. Nothing
about a research run actually needs a project — the plan, findings, sources and gaps all
live on the `RUN#` row, and `read_research_findings` already reads them back from there.

## Decision

A run never creates a project and never moves a chat. A research chat is an ordinary chat.
The dossier is written as a project file only when the chat already belongs to a project —
at report time (`research/report.ts`), or when the user later moves the chat into one
(`http/chats.ts`'s PATCH `projectId` → `lib/researchDossier.ts`'s
`writeDossiersForChatMove`, which records `dossierProjectId` on the run row so a chat moved
twice doesn't accumulate duplicate copies). `read_research_findings` is no longer a
sensitive-chat carve-out: a `hasResearch` flag on the chat row (set by `report.ts`) offers
it in any chat that has completed a run. For the user, `GET /api/chats/{chatId}/research?dossier=1`
renders the same markdown document on demand, downloadable from the chat details dialog.

## Consequences

A project-less research chat has no dossier *file*, so the model reaches its findings
through `read_research_findings` rather than `read_project_file` — one tool instead of two
paths, and it works identically for sensitive and ordinary chats. Projects created by runs
before this change keep their dossier files and their chats; nothing is migrated or cleaned
up, since they are valid projects a user may have since built on. Rejected: keeping the
auto-created project but collapsing a single-chat project into the chat list as a display
shortcut — that hides the coupling instead of removing it, and leaves the orphan-on-delete
and duplicate-naming problems intact.
