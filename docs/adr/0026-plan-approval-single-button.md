# 0026: Plan approval is a single button, not separate Approve/Revise

## Status

Accepted

## Context

`ResearchPanel.tsx`'s plan-approval step had two buttons, Approve and Revise. A user typed
feedback intended as revision input, then clicked Approve by habit (it was the primary/left
button) — the feedback was silently discarded as a steering note rather than triggering a
new plan. Two adjacent buttons with a shared feedback textarea invite exactly this mistake:
nothing in the UI signals which button an already-typed feedback should go to.

## Decision

One button. Its action and label are derived from the feedback text: empty, or text that
reads as inconsequential agreement ("OK", "looks good", "proceed", etc. — a small
allowlist regex, `INCONSEQUENTIAL_FEEDBACK` in `ResearchPanel.tsx`), submits Approve
(feedback still passed through as a steering note). Anything else is treated as intent to
revise. The button icon/label switches live as the user types, so the action about to
happen is always visible before it's taken.

## Consequences

- Removes the two-button ambiguity that caused lost feedback; the button always reflects
  what will happen with the current textarea content.
- The heuristic is a fixed client-side regex, not an LLM classification call. Rejected
  alternative: send the feedback to a backend classifier (Haiku call, matching the
  `safeParse`-JSON pattern used elsewhere) to decide "does this change the plan." A regex
  covers the actual failure mode (rote acknowledgement typed out of habit) with no added
  latency or new endpoint; a genuinely ambiguous phrase falls through to "revise", which is
  the safer default — plan revision never loses the user's input, whereas a
  wrongly-classified approve would.
- A false negative (real agreement not in the allowlist, e.g. "yeah that's fine") revises
  with that text as feedback rather than approving as-is — an extra planning round, not a
  lost interaction, so the failure mode stays cheap.
