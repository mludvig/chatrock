# 0028 — The composer owns per-send controls; the header only identifies the chat

## Status

Accepted (2026-08-22)

## Context

The chat header carried a Private toggle, project picker, model select, research-depth select
and a settings cog in a `flex-shrink: 0` row, on top of a second permanent 45px row (the global
brand/search header). On a 390px phone that meant ~90px of chrome and a header whose right-hand
half — including the settings cog — was pushed off-screen and unreachable. Long project names
made it worse by consuming the row before the controls got any. The header was also the busiest
surface on desktop, where the space existed but the density didn't help.

Separately, focusing the composer on iOS scrolled the whole app up out of view: iOS does not
resize the layout viewport for the on-screen keyboard, so `100dvh` and `position: sticky` are
both powerless.

## Decision

Split the controls by what they're *about*. Controls that describe **the message you're about to
send** — model, research depth, target project, Private — move into a `.composer-toolbar` row
directly above the textarea, one code path on desktop and mobile. The header keeps only what
identifies the chat (title, project chip) plus two navigational actions (new chat, details cog).
Everything item-scoped and infrequent stays in `ChatDetailsDialog` as before.

On mobile the global brand/search header folds into the slide-in drawer instead of holding a
permanent row, and the chat header gains its own "+ new chat" so the most common action stays
one tap away.

Viewport height is driven from `window.visualViewport` into a `--app-h` custom property with
`.layout` pinned `position: fixed` (`lib/viewportHeight.ts`), plus
`interactive-widget=resizes-content` for Android Chrome.

`models` is added to the Zustand `persist` partialize list and revalidated outside the loading
gate, so the model picker renders populated on first paint.

## Consequences

Mobile chrome drops from ~90px to 45px and nothing can overflow: the toolbar scrolls
horizontally rather than wrapping, and the header's project chip is width-capped with an
ellipsis (180px desktop / 120px mobile, full name in the tooltip). The per-send controls sit
where the decision is made and stay visible when the keyboard is open.

Costs: the composer is one row taller in every chat, and search is drawer-only on mobile (a
deliberate action, not a per-message one). A cached `models` list can be one deploy stale for the
duration of a single page load — acceptable because `GET /api/models` returns a static
server-side constant, and a chat whose model was genuinely retired is already self-healed by
`resolveChatModel()` on the backend.

Alternatives rejected: letting `.header-controls` wrap or scroll — keeps the density problem on
desktop and makes header height variable; moving model/depth into the details dialog — research
depth is a per-turn choice and burying it two taps deep is worse than the crowding it fixes.
