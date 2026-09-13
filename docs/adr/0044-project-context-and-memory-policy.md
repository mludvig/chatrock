# 44. Enforce project context policy consistently

## Status

Accepted.

## Context

Project screens, search, and tool reads applied different privacy rules. Project
memory could be disabled in settings while normal turns still read and wrote it.
Turning off learning also suppressed useful chat titles and summaries.

## Decision

Sensitive chats remain visible to their owner only when deliberately revealed.
They cannot be read from another chat or write shared memory, including through
explicit tools and summary backfills. All chat lists use the same DTO.

The chat memory setting gates all memory. The project's memory setting further
gates project memory, both reads and writes. Chat titles and non-sensitive chat
summaries are organizational metadata and remain available with memory disabled.

Excluded project files cannot be searched or read through tools. Historical
content already in a conversation is not retroactively removed. Cross-chat
retrieval uses the selected active branch. GET requests do not launch untracked
summary generation; summaries are produced by turns, moves, or explicit actions.

Project defaults are returned by every project read. `defaultModel: null` clears
the override; omitted properties leave saved values unchanged.

## Consequences

Privacy and settings are enforced by the backend, independently of UI visibility.
Existing private chats retain their own content and may read permitted project
context. Turning off project memory does not disable project files/instructions.

We rejected frontend-only filtering because tools could bypass it, and rejected
deleting historical context on exclusion because that would rewrite conversations.
Removing hidden GET-side enrichment avoids work that cannot be reliably observed
or retried after the request ends.
