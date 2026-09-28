# 0054. Document names are sanitized at the Converse boundary

## Status

Accepted

## Context

Bedrock Converse rejects a document name containing anything but alphanumerics, single spaces, hyphens, parentheses and square brackets, so `report.pdf` is a `ValidationException`. The OpenAI Responses API does the opposite: it infers an `input_file`'s type from the filename extension and rejects `report` with "Unsupported file type".

## Decision

Neutral document blocks, both stored and built in memory, carry the original filename with its extension. `converseTranslate.ts` `fromNeutral` reduces it to the Converse charset on the way out. No other code strips document names.

## Consequences

- Each provider gets the name its API expects, and the attachment chip shows the real filename.
- Documents stored before this change keep their stripped names and still fail on GPT; re-attaching the file fixes that chat.
- Rejected alternative: keep stripping on write and re-append `.${format}` in the Responses translator. That makes one provider's restriction the stored default and has the others undo it.
