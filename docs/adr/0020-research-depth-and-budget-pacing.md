# 20. Research depth and budget pacing

## Status

Accepted

## Context

The agentic tool loop (`backend/src/lib/llm/loop.ts`) ran every turn against a single
module-private `MAX_TOOL_ROUNDS = 8`, identical for a one-search lookup and a
twenty-source correlation, and the model was never told how much budget remained — so it
researched at full tilt until the loop forced a final answer, often mid-investigation.
Recovery required the user to notice and type "continue"; the frontend ignored
`stopReason` entirely and the existing Continue button was gated on stream errors only,
not budget exhaustion.

Some questions genuinely need more than a handful of rounds — planning, several waves of
investigation, mid-flight steering, a synthesised report. That doesn't fit a bigger
number in a `for` loop; it's Deep Research, a separate durable multi-agent mode (tracked
separately, not built yet). This ADR covers only the single-turn loop: two depth tiers
plus the pacing and recovery machinery around them.

## Decision

- **Two tiers today, a third reserved**: `researchDepth: 'brief' | 'extended' | 'deep'` on
  `ModelSettings`/`UserPreferences`, layered user → project → chat like every other
  setting. `ROUND_BUDGETS = { brief: 3, extended: 8 }` in `loop.ts`. `'deep'` is accepted
  by the type from the start (so the composer/settings UI shape doesn't change again when
  Deep Research lands) but is treated as `extended` until that mode exists.
- **Brief is the default**, not a middle "Standard" tier. Most questions don't need eight
  rounds; the cost of guessing low is one click ("Go deeper"), while guessing high wastes
  rounds and latency on every trivial lookup. Naming the middle tier "Extended" rather
  than "Standard" follows directly — calling it "Standard" above a Brief default would
  imply the default is sub-standard.
- **Budget pacing, not just a bigger number**: once `roundsRemaining` drops to
  `max(1, ceil(maxRounds / 3))`, the loop appends a steering note to the round's tool
  results — "N of M rounds remain, wrap up or spend what's left on the one critical gap" —
  and a harder note on the actual last round. This note is appended to
  `toolResultsLive` only, never `toolResultsPersist` (the existing live/persist split from
  the tool-result caps), so it's this-invocation-only steering, not conversation content,
  and doesn't disturb the prompt-cache boundary (`docs/adr/0019`).
- **`truncated` is a distinct signal from `incomplete`/`errored`**: the exhaustion path
  produces a *complete* answer, just budget-limited — a different UX ("Continue research")
  from a stream that aborted or errored mid-turn ("Continue this answer"). Persisted as
  its own field on the turn row and mapped through to the bubble exactly like
  `incomplete` → `errored` already was.
- **Escalation is a first-class action, not a fallback.** "Go deeper" reuses the existing
  `continue: true` path — it builds on the research already done rather than discarding it
  and restarting at a bigger budget. It's offered on any answer that used a research tool
  and landed below the top tier, not only truncated ones, since a turn can be
  complete-but-shallow.
- **The composer's depth picker is sticky UI state, not a chat setting.** It initialises
  from the chat's stored default, then stays on whatever the user picks for the rest of
  that chat session, but is merged into `modelSettings` only at send time — it never calls
  through the same path (`handleChatSettingsChange`) that persists the chat's actual
  default. A one-off escalation should not silently become permanent; the chat's real
  default stays visible and editable only in the details dialog.

## Consequences

- **Default change alters existing behaviour.** Absent `researchDepth` now resolves to
  `brief` (3 rounds) instead of the old fixed 8 — any chat that relied on the old ceiling
  now needs one escalation click, or `Extended` set as the user's global default.
- Tuning either budget number later is a one-line change to `ROUND_BUDGETS`.
- The pacing note being live-only means it never appears if the transcript is replayed or
  inspected later — intentional, since it's meta-instruction for that call, not something
  the model said or the user should read as conversation.
- `'deep'` selecting silently behaves as `'extended'` until Deep Research ships; the
  composer picker and both settings-default pickers show it but keep it disabled so the
  gap is visible rather than a silent no-op.
