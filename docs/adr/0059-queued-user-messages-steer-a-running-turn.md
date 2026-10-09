# 0059. Messages sent during a turn are queued and steer it

## Status

Accepted

## Context

A research turn can run for minutes. During that time the user often wants to correct its direction ("skip the 2019 papers", "focus on pricing"), but the composer was locked until the turn finished, and Stop discarded the remaining work. Two concurrent turns on one chat would also race to move `activeLeafId`.

## Decision

Every message goes through the same `sendMessage` path, and the chat row holds the coordination state:

- **Claim.** A send claims the turn by setting `streamingSince` with a conditional update. The update succeeds only when no marker exists or the marker is older than `STREAM_STALE_MS`, which is 16 minutes.
- **Queue.** If the claim fails, the send is appended to `pendingMessages`. That append succeeds only while the marker is live. The client receives a `queued` frame.
- **Inject.** After each tool round, the loop's `takeUserMessages` hook removes the whole queue. It writes each message into the tree as an ordinary user turn, under the latest turn and in order, and sends `user_message_injected` for each. It then hands the messages to the model with the live-only line "The user sent this message while you were working:". This doesn't reset the research budget.
- **Release.** At the end of a turn, the marker is released only if `pendingMessages` is absent. When messages are still waiting, the Lambda asynchronously invokes itself (`source: 'chatrock.queuedTurn'`), and the queued messages run as the next turn on the connection of the last sender. Async retries are off, because the queue is removed at the start and a retry would have nothing to run.

Edits, re-runs and continues are refused while a turn runs. The client renders injected messages as normal user bubbles. Queued messages appear dimmed after the live answer until they are injected. Stop cancels only the current turn; queued messages still run afterwards.

## Consequences

The user can steer a long turn without losing it, and a chat has at most one turn writing to it at a time. A message that arrives during the final round, which makes no tool call, runs as the next turn instead of being injected. A failed self-invoke clears the marker, and the orphaned messages are picked up at the next turn's first tool boundary.

Alternatives rejected:

- **A separate "steer" action used only while the client believes a turn is streaming.** It breaks when the client's view is stale, for example on another device or after the turn ended in between. One path that the server decides between has no such gap.
- **Injecting at any streaming event rather than after the tool round.** Bedrock requires each tool result to directly follow its tool use, so the tool round is the only point where a user turn can be inserted.
- **Running late messages through a client resend.** The client may be gone, which would break the rule in `docs/realtime-reliability.md` that the server finishes work with nobody listening.
