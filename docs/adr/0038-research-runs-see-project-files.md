# 0038 — Research runs see project files, through the planner and the report

## Status

Accepted.

## Context

ADR 0033 gave a run's planner the user's memory and the project's instructions/memories,
but not the project's files. A research question asked inside a project chat still had no
way to reference a file the user had already uploaded there — the planner couldn't point a
sub-question at it, and the final report couldn't cite or quote it, even when the file was
marked `inclusion: 'always'` and would have been injected into a normal chat turn via
`assembleSystemPrompt`.

## Decision

`context.ts` gains `buildRunProjectContext(projectId)`, built the same way
`buildRunContext` is: a navigational manifest (`[fileId] filename — microLabel`, capped at
`FILE_MANIFEST_CAP`=50, excluding `inclusion: 'never'`) plus the full text of any
`inclusion: 'always'` file (same per-file/total caps `assembleSystemPrompt` uses —
20 KB/80 KB). `ws/startResearch.ts` snapshots it onto the `RUN#` row as `projectContext`,
alongside `context`. `resolveRunProjectContext(event)` reads it back.

Unlike `context`, both `plan.ts` and `report.ts` read it — the planner to write file
references into sub-questions, the reporter to draw on force-included file content when
synthesising the final answer. Researchers do not: they have no chat context to draw on
(ADR 0033's reasoning) and no `read_project_file` tool in a research run.

## Consequences

- A project chat's Deep Research run can reference and quote a project file the same way a
  normal turn would, without giving researchers a tool loop over the project's files.
- Read-only, manifest/forced-only for this pass — no `read_project_file` tool for
  plan/report. If a run needs to pull an L1/L2 file on demand later, that's a separate,
  larger change (a tool loop inside `plan.ts`/`report.ts`), not an extension of this
  snapshot.
- Snapshotted at start, not re-read per phase, for the same reason `context` is: no
  `ResultPath` on `AwaitApproval`/`Assess` to carry a threaded field through, and a run
  shouldn't shift under the user if a file changes mid-run.
- A sensitive chat still gets `projectContext` — this is data flowing in, not out; ADR 0008
  only restricts sensitive chats from writing facts outside themselves.
