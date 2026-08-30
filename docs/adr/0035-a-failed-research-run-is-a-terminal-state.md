# 0035 — A failed research run is a terminal state, and a dead researcher is a gap

## Status

Accepted.

## Context

A run whose Step Functions execution failed left its `RUN#` row on `status: 'running'`
forever: nothing but `report.ts` ever wrote a terminal status, and the state machine had no
`Catch` anywhere. Two things followed, neither recoverable by the user. The progress panel
spun on a run that no longer existed, and `getActiveRun()` — which treats anything not
`done`/`failed` as active — kept diverting every subsequent message in that chat into the
run's `steeringNotes[]`, so the chat silently stopped answering. Observed live: a researcher
hit its 300 s Lambda timeout, the `Wave` Map aborted its six healthy siblings, the execution
failed, and the chat was wedged with no way back.

## Decision

Three changes, in the order a failure meets them:

1. **A researcher's failure degrades its sub-question, not the run.** The `Wave` iterator
   retries transient Lambda-plane errors, then catches everything else into a `Pass` state
   that emits a placeholder `Finding` in the same shape a real one has. `assess.ts` merges it
   like any other finding and may re-research the gap in a later wave. A timeout is
   deliberately not retried: it already spent its full budget.
2. **Every state catches into a `RunFailed` task** (`research/fail.ts`) that writes
   `status: 'failed'` plus a `failureReason`, pushes a `research_failed` frame, and then
   re-fails the execution so alarms and the console still see a FAILED run. It leaves an
   already-terminal row alone, since `Report`'s own catch can fire after the report was
   persisted.
3. **Timeouts and memory sized from measurement, not guess.** Researchers were running
   219–252 s against a 300 s ceiling at the 128 MB default, pinned at 128/128 MB used — a
   hard CPU throttle on a handler whose entire job is a long agentic loop. Now 900 s and
   1024 MB across the research handlers.

## Consequences

A crashed run now ends visibly and releases the chat. A wave survives losing a researcher,
at the cost of a report that may be written from an incomplete set of findings — the
placeholder finding says so in words the report model reads, and the gap surfaces in
`gapsNotPursued`.

Rejected: **failing the whole run when any researcher dies** (the previous behaviour) — it
throws away up to 50 minutes of completed work, including an approval cycle the user sat
through, over one sub-question. Rejected: **retrying a timed-out researcher** — a second
900 s attempt at the same sub-question is far more likely to time out again than to succeed,
and doubles the wall-clock before the user learns anything. Rejected: **a heartbeat/sweeper
that reconciles stale `RUN#` rows against Step Functions** — more moving parts than a
`Catch`, and it can only ever act after a delay the user spends staring at a spinner.
