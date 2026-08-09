# 16. Parallel tool execution within one agentic round

## Status

Accepted

## Context

Bedrock can return multiple `tool_use` blocks in a single `ConverseStream` response — e.g. the model batching several `web_search`/`web_fetch` calls to gather sources before writing an answer. `converseStream`'s tool-execution step (`backend/src/lib/llm/loop.ts`) ran these one at a time in a plain `for...of` loop, so a round of N tool calls paid N times the latency of the slowest one, even though the calls are independent (nothing in one call's input depends on another's output within the same round).

`web_fetch` (Jina, static HTML) also silently returns near-empty content on JS-rendered pages with no signal for the model to retry a different way — a separate issue but discovered while looking at the same file.

## Decision

- Execute a round's tool calls concurrently, capped at `TOOL_CONCURRENCY = 5` in flight at once (a small pool, not an unbounded `Promise.all`) — bounds how hard a single round can hit rate-limited backends (Jina) or spin up AgentCore browser sessions at once. Per-call output is still capped adaptively by `toolUses.length` as before (`perCallCap`), unaffected by execution order.
- Results are written into pre-sized arrays indexed by the tool's original position (`toolUses[i]`), not push order, so persisted tool-result order always matches the model's original `tool_use` order even though completion order is now nondeterministic. `tool_result` WS chunks are still emitted as each call finishes (streaming UI feedback), which is fine since the frontend matches them to pills by `toolUseId`, not arrival order.
- The single per-call heartbeat loop became one shared heartbeat loop across all in-flight calls (`Promise.race` over the running pool vs. one timer), preserving the same "heartbeat every 4s while something is in flight" behavior from `docs/adr/` heartbeat conventions, just no longer restarted per call.
- Separately: `web_fetch`'s tool description now tells the model to retry with `get_rendered_page` on a thin/empty result, and `jinaFetch` itself appends an explicit hint string into the returned text when content is under ~40 chars — belt-and-suspenders, since a model mid-tool-call won't re-read the tool description on its own.

## Consequences

- A round with N independent web calls now takes roughly `max(latencies)` instead of `sum(latencies)`, capped at 5 concurrent.
- Tool execution errors still can't crash the round: `executeTool` already catches internally and returns an error `ToolResult`; this was unchanged by the refactor.
- Slightly more code in `loop.ts` (a small manual concurrency pool) versus the previous straight-line loop — no external dependency pulled in for this, since the pool logic is ~15 lines and needs to interleave with heartbeat yielding, which a library like `p-limit` doesn't natively support inside a generator.
- The JS-render fallback is a soft nudge (description + text hint), not a hard fallback the backend performs automatically — keeps `web_fetch` fast and cheap by default; only calls `get_rendered_page` (a real browser session) when the model actually decides thin content warrants it.
