# 46. User-maintained project facts and recoverable file management

## Status

Accepted.

## Context

Users could edit generated memories but could not add facts directly. Automatic
reconciliation could overwrite their edits. Project files displayed summaries
without opening the original, and an interrupted upload could spin indefinitely.

## Decision

Add an authenticated POST project-memory route. Facts added or edited through
the UI carry `userEdited: true`; automatic reconciliation retains these facts
unchanged. Explicit memory operations remain available. Newly generated facts
record the source chat; old facts without provenance remain valid.

The file list returns signed URLs for ready originals. File status is refetched
on resume and every five seconds during processing; status older than fifteen
minutes is displayed as a recoverable error. Retry reuses finalization, while
missing uploads can be removed and uploaded again. Original file IDs remain
stable throughout a client upload operation.
Refreshes preserve known local failures until processing succeeds. An incomplete
upload found after reload offers finalization retry; a locally active upload
does not show that action while its bytes are still being transferred.

File inclusion uses honest labels: relevant material, an included excerpt, or
excluded context. Excerpts disclose character limits; images cannot be chosen
for text-only forced inclusion. Exclusion applies to future retrieval, not
content already persisted in a chat. File actions can prepare a draft explicitly
referencing that file.

## Consequences

Users can curate knowledge without a chat round trip and can inspect originals.
Refresh recovers a missed finalization response. A failed upload before bytes
reach storage still requires re-uploading the local file.

We rejected an additional file job service for this iteration because durable
status plus bounded recovery can reuse the current processor. Replacing a file
is currently a deliberate delete/upload operation, preserving the distinction
between an old source and new material. Provenance records the latest writing
chat, not a complete history; moving a chat does not retract previously learned
facts automatically.
