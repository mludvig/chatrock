# 0034 — Research runs carry the question's attachments

## Status

Accepted.

## Context

Sending an image or document with a Deep Research question silently dropped it: `startResearch`
persisted the user turn as a hardcoded text-only block, and the frontend's Deep Research call
sites never forwarded the already-uploaded attachment refs. The planner would then reply that it
couldn't see any attachment, even though the user's own bubble showed it.

## Decision

`startResearch.ts` now builds the user turn's blocks with the same `buildUserBlocks` helper a
normal send uses (moved from `ws/sendMessage.ts` into `lib/attachments.ts` so both entry points
share it), and snapshots the attachment refs (`AttachmentMeta[]`, never bytes) onto the `RUN#`
row as `attachments` — the same read-back pattern ADR 0030/0033 use for `model`/`context`, since
`getRun` returns the raw untyped item and a new attribute needs no Step Functions payload change.
`research/attachments.ts`'s `resolveRunAttachmentBlocks` reads the row, turns the refs into
`Block[]`, and hydrates them; `plan.ts` and `report.ts` prepend the result to their `converseOnce`
call. A Deep Research send with an attachment but no typed text is blocked client-side with a
toast instead of relaxing the backend's text-required guard, since that failure would otherwise
only surface as the ack watchdog's timeout.

## Consequences

- Only Plan and Report see the attachment. Plan needs it to scope sub-questions; Report needs it
  to reference it in the write-up. Rejected: giving every wave researcher the attachment too —
  each sub-question is answered independently and in parallel, so re-sending the same image to N
  researchers per wave would multiply input tokens for no benefit; `recon.ts` has no model call at
  all and stays untouched.
- Snapshotted once at `startResearch` rather than re-resolved from the live message tree, for the
  same reason as `context`/`model`: `AwaitApproval` and `Assess` have no `ResultPath`, and a run
  should not shift under the user if they attach something different to a later message.
- Hydration (`s3Uri` → bytes) happens inside `resolveRunAttachmentBlocks`, not at each call site,
  so a future phase that reads the row can't forget it — mirroring why `converseOnce` itself
  never hydrates automatically.
