# 3. Single DynamoDB table for all entity types

## Status

Accepted

## Context

Chatrock stores chats, per-turn messages, WebSocket connections, user preferences, user/project memories, projects, and project files. All of it needs to be queryable, deletable in cascades, and cheap to operate for what is fundamentally one small app's data.

Alternatives considered:

1. **One table per entity type** (Chats, Messages, Users, Projects, ...) — the conventional relational-style decomposition. More familiar to browse, but every table carries its own backup/PITR/streams/IAM configuration, and cross-entity operations (e.g. "delete everything under this chat") become multi-table fan-outs.
2. **Single table, overloaded `PK`/`SK`** (`terraform/dynamodb.tf`'s `chatrock-<env>` table) — the standard DynamoDB single-table-design pattern. Each entity type gets a distinguishable key shape: `PK=USER#<sub>`/`SK=CHAT#<chatId>` for a chat, `PK=CHAT#<chatId>`/`SK=MSG#...` for a turn, `PK=USER#<sub>`/`SK=PREF#USER` for preferences, etc. (full schema in root `CLAUDE.md`).

## Decision

Single table (option 2). Every access pattern in the app is a single-partition query scoped by owner (`sub`) or by chat — none of them need a secondary index, so one well-keyed table satisfies all of them. This also means one DynamoDB Streams source and one cascade-delete Lambda (`stream_chat_cleanup`, see ADR 0006) can handle deletion for every child entity type living under a chat's partition, rather than coordinating deletes across several tables. TTL is likewise shared: one `ttl` attribute already used by WS `CONN#` rows was reused for ephemeral-chat expiry rather than adding a second TTL-enabled table.

## Consequences

- Every access pattern has to be known up front to choose `PK`/`SK` correctly. A genuinely new query shape discovered later may need a GSI rather than "just query the table" — a real cost of single-table design, traded for not needing one yet.
- Ad-hoc console browsing is harder: a `Query` on a user's partition returns a mix of Chat/Pref/Memory/Project item shapes interleaved. Mitigated by keeping `SK` prefixes (`CHAT#`, `PREF#`, `MEM#`, `PROJECT#`) immediately identifying an item's type.
- The cascade-delete design (ADR 0006) is only as simple as it is because every child item of a chat lives in the same table and partition scheme — splitting tables later would also require rethinking that cascade.
