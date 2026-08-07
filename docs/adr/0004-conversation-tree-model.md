# 4. Conversation tree model instead of a linear message history

## Status

Accepted

## Context

Chat features needed over time — editing a past message and getting a new answer, re-running an answer, forking a chat, navigating between alternate answers — don't fit a simple linear array of messages per chat.

Alternatives considered:

1. **Linear message array per chat** (the conventional chat-UI model). Simplest to query and render, but editing/re-running/forking all require either mutating history (destroying prior answers) or bolting ad hoc "versions" arrays onto individual messages — awkward and hard to extend.
2. **Full CRDT / version-vector model.** Handles arbitrary concurrent multi-writer editing, but is significant complexity for a single-owner, effectively single-writer-at-a-time chat — no concurrent-edit use case exists here.
3. **Tree of turns.** Each `Message` row carries `msgId` (UUID) + `parentId` (`null` at root), forming a tree per chat. The chat record's `activeLeafId` points at the current branch tip.

## Decision

Tree of turns (option 3), implemented in `backend/src/lib/tree.ts`. `GET /messages` runs a single DynamoDB Query over the chat's full partition, then walks the in-memory tree to extract the active root→leaf path (`buildActivePath`) plus per-node sibling metadata for the UI's branch-nav arrows. Editing a message creates a new sibling under the same parent; re-running creates a new sibling assistant turn; forking clones the active path into a new chat. `resolveSafeLeaf` is the one validated chokepoint for ever moving `activeLeafId`, falling back to `mostRecentLeaf` rather than persisting a pointer to a node that doesn't exist.

## Consequences

- Every read pays for loading and walking the chat's *entire* partition into memory rather than a bounded-range query — fine at chat-sized partitions (hundreds of turns) but would not scale to a hypothetical chat with tens of thousands of messages.
- `activeLeafId` is one mutable pointer per chat — correct for the current single-owner-editing-one-chat-at-a-time model, but would race under true concurrent multi-client editing of the same chat, which isn't a supported use case today.
- Edit / re-run / fork / sibling-navigation all become different read/write patterns over the same tree structure rather than four independently-implemented features, and a corrupted or stale `activeLeafId` degrades gracefully (falls back to the most recently created leaf) instead of breaking the chat.
