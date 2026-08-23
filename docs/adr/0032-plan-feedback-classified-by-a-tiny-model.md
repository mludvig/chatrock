# 0032: Plan feedback arrives through the main composer and is classified by a tiny model

## Status

Accepted. Supersedes `0026-plan-approval-single-button.md`.

## Context

The plan-approval step rendered its own feedback textarea inside `ResearchPanel.tsx`. On a
phone the panel is metres of scroll above the fold while the main composer stays pinned to
the bottom, so feedback was typed into the composer instead — and a composer send during a
run is intercepted by `ws/sendMessage.ts`'s steering path, which appended it to
`steeringNotes[]` and returned. `getActiveRun()` counts `awaiting_approval` as active, so
the approval task token was never released: the run sat blocked until `AwaitApproval`'s 24h
timeout, and the note it was turned into is only ever read by a wave that had not started.
Two input boxes for one question, and the one users could actually see stalled the run.

## Decision

The main composer is the only input for plan feedback. `ws/sendMessage.ts` branches on the
active run's status: `awaiting_approval` routes the message to the approval gate, anything
else keeps the existing steering behaviour. `ResearchPanel.tsx` keeps one "Approve & start"
button — the shortcut for the common no-feedback case — and no textarea.

What the reply means is decided by a `TINY_MODEL` (Haiku) call, `classifyPlanFeedback()`,
returning `approve` (bare consent), `approve_with_steering` (consent plus guidance that
does not change the plan) or `revise`. The token-releasing mechanics move to
`lib/researchApproval.ts` so the button and the composer share one implementation.

## Consequences

- Fixes the stall: a reply typed where the user can see it now resolves the gate.
- Replaces 0026's `INCONSEQUENTIAL_FEEDBACK` allowlist regex, which 0026 chose over a
  classifier call to avoid latency and a new endpoint. Neither cost materialised: the call
  is one Haiku round on a path that is already about to spend minutes on a research wave,
  and it reuses `converseOnce`. The regex could not have worked here anyway — it only ever
  saw text typed into a box that no longer exists, and it cannot tell "yes, region is
  Europe" (an answer to a clarifying question) from "yes".
- The classifier recovers the three-way outcome the backend always supported; the regex
  collapsed steering and approval into one.
- Failure (throttle, unparseable output) falls back to `revise`, the recoverable answer: a
  needless replan costs one round and shows the user the plan again, whereas starting a
  wave on a misread instruction cannot be taken back.
- A misclassification is now the model's rather than a regex's, and is not visible to the
  user before it happens — 0026's live-switching button label was. The button covers the
  case where being sure matters most (start it exactly as proposed).
- Clarifying questions render numbered, and `plan.ts` hands the Replan step the same
  numbering, so "#1 I mean xyz" resolves to the item the user was looking at.
