# 0037. Catching up on a dropped stream is a refetch, not a re-attach

## Status

Accepted.

## Context

Stream frames are addressed to one connection id. When a client drops mid-turn the backend keeps going — `safePost` swallows the 410, each round is persisted, `activeLeafId` advances — but those frames are gone, and a new socket cannot be attached to a stream already in progress. The reconnected client had no way to tell "the answer is still coming" from "nothing is coming", so it showed a stalled bubble until a manual reload, and even then could not know to look again.

## Decision

`ws/sendMessage.ts` sets `streamingSince`/`streamingResponseId` on the chat row when a turn starts and removes them when the loop exits (any of errored, cancelled, or normal). `GET /messages` exposes a boolean `streaming`, treating a marker older than 11 minutes as debris, since a Lambda killed at its 600 s ceiling clears nothing. While that flag is set and the client is not itself streaming, `ChatView` re-fetches the transcript every 3 seconds and shows a "catching up" banner; a header Refresh button does the same on demand.

## Consequences

Catch-up shows completed rounds rather than live tokens — a long agentic turn advances in 3-second steps instead of streaming — which is the honest limit of a refetch. The marker is written on the chat row without touching `updatedAt`, so polling does not reorder the sidebar. Two extra DynamoDB writes per turn.

Alternatives rejected: re-attaching a new connection to the running stream — the Lambda holds one connection id and buffering frames server-side for an absent client is a queue with no owner; inferring "still streaming" from the transcript shape — a trailing user turn looks identical whether the answer is coming or the Lambda died.
