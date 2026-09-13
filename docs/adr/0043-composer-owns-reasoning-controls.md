# 0043 — The composer owns reasoning controls

## Status

Accepted (2026-09-16)

## Context

Research depth was exposed twice for a chat: the composer had a session-only override for
the next turn, while Chat details and Project details held a persistent default. Thinking
effort appeared only in those details dialogs. The two surfaces made it unclear which
value would be used for the next message, and made the controls difficult to compare.

Both settings affect the reasoning budget for the message being composed, rather than a
durable property of the chat's identity or its available tools.

## Decision

Show thinking effort and research depth only in the composer toolbar, alongside the model
picker. Both are session-scoped overrides: existing saved chat, project, and user-default
values seed the controls when a chat opens, and a selection applies to later turns in that
chat session without overwriting those saved defaults. The overrides reset when the user
switches chats.

On narrow screens the toolbar remains a single row. Its controls shrink within deliberate
minimum widths; project selection remains icon-only until a project is chosen and the
Private control remains icon-only. This keeps every control tappable without horizontal
overflow or a second composer row.

## Consequences

There is one visible source for the next turn's reasoning configuration, and a model that
does not support thinking simply omits the thinking-effort picker. Saved defaults remain
available as the initial value but are no longer edited from a chat or project cog.

The trade-off is that changing either control is no longer a way to persist a new
chat/project default. The user can still set app-wide defaults in Preferences; a
session-level override is the appropriate scope for a control directly above the input.

Alternatives considered:

- Keep the cog defaults and synchronize their values with the composer. This leaves two
  competing controls for one turn and does not clarify whether a change is durable.
- Persist every composer change to the chat. This makes an incidental one-turn escalation
  silently alter later turns.
- Add a second composer row on mobile. It keeps labels roomy but costs vertical space while
  the on-screen keyboard is open.
