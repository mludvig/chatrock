# 0060. Reconcile the fetched chat list with local changes

## Status

Accepted

## Context

App loads chats, preferences and projects whenever the access token changes, which includes a silent renewal mid-session. The chat list response replaced the store outright, so a chat created in this tab while the request was in flight vanished from the store: its header fell back to "Chat" and chat-level actions (Re-run, Share, Fork) had no chat to act on.

## Decision

`lib/chatList.ts` `mergeFetchedChats` snapshots the chatIds in the store when the request starts. A chat added locally since then is kept even if the response lacks it. A chat removed locally since then stays removed. Everything else follows the server, including drops of chats the server no longer has.

## Consequences

The decision uses chatId set membership, so it never depends on clock skew between the client and the server's `createdAt`. A rename or flag change made locally during the request is still overwritten by the fetched copy. That window is short, and the next refetch corrects it.

Alternatives rejected:

- Keeping local chats whose `createdAt` is newer than the request start depends on clock skew.
- Dropping `accessToken` from the effect's dependencies narrows the window but leaves the overwrite in place for the initial load and Retry.
