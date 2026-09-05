# 0025: Researcher findings use a plain-text summary, not a nested JSON string

## Status

Superseded by `0039-deep-research-as-a-sub-agent-tool.md`.

## Context

`research/researcher.ts`'s final turn was originally `{"summary": "...", "sourceUrls": [...]}`,
parsed with `safeParse` (same helper `plan.ts`/`assess.ts` use). A live Deep Research run
showed 2 of 5 findings with `summary` containing raw, still-JSON-encoded text (e.g.
`"summary":"{\n  \"summary\": \"Short answer: ...`), visible to the user in the
in-progress `ResearchPanel` findings list. The `summary` field is long, quote-heavy prose —
asking the model to nest that inside a JSON string means every unescaped `"` or literal
newline inside the model's own answer breaks `JSON.parse`, and `safeParse`'s brace-slicing
fallback can't recover a genuinely malformed inner string.

## Decision

The researcher's final-turn contract is now plain-text/markdown prose, followed by a
trailing `SOURCES: [...]` line holding a JSON array of strings. `researcher.ts` parses this
with a regex anchored to that trailing line, not `JSON.parse` over the whole turn — prose
never has to survive JSON-escaping. A turn with no `SOURCES:` line falls back to the legacy
nested-JSON shape (`safeParse`d), and that falling back to `{summary: <raw text>}` — the
existing malformed-output behavior is preserved, just demoted to a second fallback instead
of the primary path.

## Consequences

- Findings summaries are readable prose even when the model's answer contains quotes,
  code fences, or multi-line lists — no more nested-JSON leakage into `research_finding`
  WS frames.
- `report.ts`, `assess.ts`, and the dossier writer are unaffected — they only consume
  `Finding.summary`/`sourceUrls`, not the wire format.
- Alternative considered: keep `safeParse` and just tell the model to escape quotes more
  carefully. Rejected — prompt instructions don't reliably fix JSON-escaping mistakes in
  long free-text generation, and the failure mode (raw JSON leaking to the user) is worse
  than a slightly less rigid parser.
