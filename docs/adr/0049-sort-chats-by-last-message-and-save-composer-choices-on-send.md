# 0049 — Sort chats by last message, and save composer choices on send

## Status

Accepted (2026-09-22). Supersedes the session-only scope of composer overrides in
[0043](0043-composer-owns-reasoning-controls.md).

## Context

The chat list was ordered by `updatedAt`, which every metadata write moves: renaming,
moving a chat to a project, changing a setting, picking a model, even a read that healed a
retired model ID. Chats jumped to the top without anyone talking to them. Model selection
was saved immediately from the dropdown, while thinking effort and research depth were
session-only, so the three controls next to the input behaved differently.

## Decision

- A new `lastMessageAt` chat attribute, stamped only when a message is submitted
  (`recordChatSend` in `ws/sendMessage.ts`), orders the chat list and project activity,
  falling back to `createdAt`. `updatedAt` keeps meaning "row changed" and orders nothing.
- Reads never write. A retired model ID is replaced with `DEFAULT_CHAT_MODEL` in the
  response only (`resolveChatModel`, with `modelMigratedFrom` for the notice).
- The model, thinking effort and research depth are saved with the message they were sent
  with, not on selection. Only effort and depth are merged into the stored overrides, since
  the rest of the sent settings are already-resolved defaults (0045). A continue ("Go
  deeper") keeps its depth out, because that is a one-off escalation.
- Switching model keeps the selected thinking effort when the new model supports it.
- Private and the Chat details settings still save immediately: they are properties of the
  chat, not of the next message.

## Consequences

Metadata edits no longer reorder the list, and a chat's saved model always matches its last
message. Selecting a model and leaving without sending changes nothing. The backfill
sets `lastMessageAt` from each chat's latest message.

Alternatives considered:

- Stop the metadata writers from touching `updatedAt`. It fixes the order but leaves
  `updatedAt` lying about when the row changed, and every future writer must remember.
- Keep saving the model on selection. An idle click would change a chat's model and, with
  `updatedAt` ordering, reorder the list.
- Keep effort and depth session-only (0043). The three composer controls would keep
  behaving differently, and reopening a chat would drop what its last message used.
