# 0055. Document tool results persist as a pointer to the project file

## Status

Accepted

## Context

`read_project_file` with `detail:'full'` on a PDF returns the raw PDF so the model can read it natively. Tool-result entries were text or image only, so the agentic loop discarded the document. The model saw only the caption "The complete PDF is included above."

## Decision

Tool results can carry a `document` entry, and both provider translators support it. `loop.ts` sends the model the bytes during the turn. The persisted turn stores only an `s3Uri` pointing at the project file's existing S3 object. `hydrateBlocks` loads the bytes again on later turns. If the project file was deleted in the meantime (`NoSuchKey`), the entry becomes a short text note and the chat keeps working.

## Consequences

- The model reads the PDF on the turn it asks for it, and again whenever history is replayed later.
- A chat that referenced a deleted project file loses the document content on replay but does not fail.
- Rejected alternative: copying the PDF into the chat's S3 prefix, as browser screenshots are. The copy would outlive a deleted project file, but it duplicates up to 25 MB on every read. It would also need extra handling in fork and cascade delete.
