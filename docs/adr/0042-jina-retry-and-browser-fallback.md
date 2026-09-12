# 0042 — Jina retries once, then hands off to the browser

## Status

Accepted.

## Context

`web_search` / `web_fetch` go through Jina (`s.jina.ai` / `r.jina.ai`), which fails
transiently — 502/504, dropped sockets, the occasional throttle — noticeably more often than
it fails for a real reason. Every such blip previously surfaced to the model as
`Tool error: Jina fetch failed: 503` and cost the turn a whole agentic round, or the answer.
Tool failures were also invisible in CloudWatch: `executeTool`'s catch-all turned them into a
tool result without logging anything.

Jina is also a static fetcher — it does not run JavaScript. A JS-rendered page comes back
empty rather than failing, and a search whose result list is built client-side comes back with
nothing. The AgentCore browser (`get_rendered_page`) can see both, but the model only reaches
for it if something tells it to at the moment the gap appears.

## Decision

- **One immediate retry** (400ms) inside `jinaGetJson`, shared by search and fetch, for
  network-level throws and 408/429/5xx. A non-throttle 4xx is a real answer, not a blip — no
  retry. Retries log `jina_retry`; exhausted failures log `web_search`/`web_fetch` with
  `result: 'error'`.
- **Failure and emptiness both point at the browser.** A failed `web_fetch` tells the model to
  call `get_rendered_page` on the same URL; a failed or empty `web_search` tells it to run the
  query through `get_rendered_page` on a DuckDuckGo URL and then read the best result. This is
  a runtime hint attached to the result, not only a line in the tool description — the model is
  told at the point the gap actually appears.
- **The hint is gated on the tool really being callable.** `loop.ts` derives
  `ToolContext.browserAvailable` from the tool list it just built (`get_rendered_page` present)
  and passes it to every tool execution. A research sub-agent runs with
  `browserCoreEnabled: false`, so it gets the bare error rather than advice to call a tool it
  does not have.

## Consequences

- A transient Jina blip costs 400ms instead of a round; a real failure now arrives with a route
  out rather than a dead end.
- The DuckDuckGo hop is best-effort — bot detection can block it. It is a fallback suggestion,
  not a guaranteed second search provider.
- Rejected: retrying at the agentic-loop level (the model would see the failure and burn a
  round deciding what to do); auto-invoking `get_rendered_page` in the executor when Jina fails
  (hides a browser session's cost and latency behind a tool the model thinks is a cheap static
  fetch — the model should choose); switching the default search provider to AgentCore (a
  different reliability profile, not obviously better, and orthogonal to this).
