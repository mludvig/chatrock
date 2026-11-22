---
name: model-upgrade
description: Add, replace, upgrade or retire an LLM model in chatrock (backend/src/config/models.ts) — research the Bedrock model card, live-probe its capabilities and gotchas through the app's own provider adapters, update the registry, `replaces` lists, role constants (default/title/memory/visual/tiny models), README, unit tests and e2e specs, then commit, deploy and run e2e. Use this whenever the user mentions a new model version, a model being superseded or retired, swapping a model (e.g. "add gpt-6.1-terra", "Sonnet 5.6 is out", "replace Haiku", "drop Grok 4.6"), or asks to re-verify what a model supports, even if they don't say "upgrade".
---

# Model upgrade

Chatrock's model registry is `backend/src/config/models.ts`. Each entry's `capabilities`
drive real request shapes in the provider adapters (`backend/src/lib/llm/providers/`), so a
wrong flag is not cosmetic: a `cachePoint` sent to a model without caching is an
`AccessDeniedException`, a forced `toolChoice` sent to a model that rejects it fails every
Search turn, a missing thinking level silently downgrades the composer. Every claim in an
entry should therefore come from a live probe, not from the model card or from the entry it
replaces. Docs tell you what *should* work; the probe tells you what the app's actual
requests do.

Read the root `AGENTS.md` "Adding or updating a model" section and `backend/AGENTS.md`
"Model capabilities" / "Retired models" first if you have not this session — this skill
is the operational version of those.

## 1. Research

- **Inference profile**: `aws.bin bedrock list-inference-profiles --region $AWS_REGION --type-equals SYSTEM_DEFINED`
  (source `.env` first). Chatrock uses the `global.*` profile. Also
  `aws.bin bedrock list-foundation-models --region $AWS_REGION --by-provider <vendor>` for
  modalities.
- **Model card**: `https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.md` lists
  every card; fetch the `.md` variant of the card (slugs vary: `gpt-6-1-terra`, `gpt-56-terra`).
  Note: context window, max output, input modalities, which APIs are supported on
  `bedrock-runtime` (Converse vs Responses decides `provider`), caching (implicit/explicit),
  document support per API, and any "doesn't accept X" caveats — those caveats are the
  gotchas worth probing. Trust the card for context window and pricing; don't probe them.
- Look at the entry being replaced and its "Verified live…" comment, and at git history for
  that model family (`git log --oneline -i --grep=<family>`) — past fixes there are the
  gotchas most likely to recur.

## 2. Probe

```bash
.claude/skills/model-upgrade/scripts/probe.sh <modelId> [--caps '<json>'] [--only a,b]
```

It bundles `scripts/probe-model.ts` with the backend's esbuild and calls
`getProvider(modelId).streamTurn` / `.once` with credentials from `.env`. If the id is not in
`MODELS` yet it registers a temporary entry (default: Responses provider, every capability
on); `--caps` merges overrides into the entry, e.g.
`--caps '{"provider":"bedrock-converse","thinking":"adaptive"}'`. Re-run with different
`--caps` values to find what the model accepts (e.g. each `thinkingOff` value, or
`forcedToolChoice:false`).

Probes, and the capability each one decides:

| probe | decides |
| --- | --- |
| `text`, `once` | basic streaming and one-shot calls (titles, enrichment, search ranking) |
| `image`, `tool_result_image` | `attachments`; browser screenshots arrive as images *inside a tool result* |
| `document_pdf`, `document_txt` | `pdf` (WEAK with pdf off is expected: the model gets a note); `document_txt` must pass on every model |
| `tool_roundtrip` | tool calling at all |
| `forced_tool`, `forced_tool_thinking_high` | `forcedToolChoice` (ADR 0058) |
| `thinking_<level>` | `thinking` mode and `thinkingLevels`; on Converse also `thinkingOff` |
| `reasoning_replay` | follow-up turns replaying this model's own reasoning (ADR 0052) |
| `caching`, `caching_after_document` | `promptCaching`; cache read must be > 0 on the repeat call |

Reading the results: `FAIL` is an API rejection — the capability is off or needs a different
value. `WEAK` means the call was accepted but the answer missed the expected content — look
at the detail before concluding (a model may describe an icon as "white"); a model that
silently ignores an image is as broken as one that rejects it. For thinking levels compare
`out=` across levels (it includes hidden reasoning tokens on Responses) and whether thinking
text streams; an accepted level that changes nothing is not a real level.

Probes cost cents. If a probe fails because the probe itself is wrong, fix
`probe-model.ts` and commit the fix with the upgrade — it is meant to improve each time.
Add a probe when you hit a new gotcha so the next upgrade checks it automatically.

## 3. Registry entry

- Replacing a model: edit the old entry in place (keeps registry order — the picker order)
  with the new id and name; move the old id **and its whole `replaces` list** into the new
  entry's `replaces`. `tests/config/models.test.ts` rejects a live id in any `replaces` list
  and any id in two lists.
- Adding a model alongside: insert it next to its family.
- Set capabilities from the probe. Update or write the "Verified live against <region> <Mon
  YYYY>: …" comment above the entry with what was verified and anything surprising. Never
  write the real region/account in a comment if it isn't already generic — see the
  identifier rule in the root `AGENTS.md`.
- If the provider needs new behaviour (a new thinking dial, a new off switch), that is a
  code change in the adapter plus a unit test, and usually an ADR — stop and confirm with the
  user before starting it.

## 4. Models with special roles

The user picks chat models, but several background jobs run on a fixed model the user never
sees. A retired id in one of these keeps running (or breaks) with nothing visible in the UI,
so check every one on every upgrade:

- In `models.ts`: `DEFAULT_CHAT_MODEL`, `VISUAL_MODEL`, `TINY_MODEL`, `TITLE_MODEL`,
  `MEMORY_EXTRACTION_MODEL` — and any new `*_MODEL` constant added since this was written
  (`grep -n "_MODEL\b.*=" backend/src/config/models.ts`).
- Hard-coded ids anywhere else: `grep -rnE "global\.(anthropic|openai|xai|moonshotai)" backend/src frontend/src shared terraform`
  (also grep the old display name).
- For each role, ask: does it point at the model being retired (must change), or is the new
  model a better fit for the role than the current one (e.g. a cheaper/faster model for
  `TINY_MODEL`, a stronger one for `VISUAL_MODEL`)? Retired references must change; propose
  "better fit" swaps to the user rather than making them silently — they change cost and
  behaviour of every chat.
- A role model must pass `once` (and for `VISUAL_MODEL`, `text` with a long output) in the
  probe.

## 5. Every other list

- `README.md` Models table and its "as of" month.
- Model examples in `AGENTS.md`, `backend/AGENTS.md`, `frontend/AGENTS.md`.
- Unit tests using the old id as a sample model (`grep -rn "<old id>" backend/tests frontend/src`).
  These matter beyond tidiness: a retired id resolves through `getCapabilities`' fallback
  (Converse, no caching), so a test on it silently tests a different provider.
- e2e: `e2e/testConfig.ts` labels, and specs selecting the old label
  (`grep -rn "<old display name>" e2e`, e.g. `e2e/openai-models.spec.ts`, `e2e/chat-order.spec.ts`).
- Add a `resolveModelId` migration assertion for the old id in `backend/tests/config/models.test.ts`.
- Leftovers: grep the old id and display name repo-wide (excluding `node_modules`,
  `graphify-out`, `dist`). Expected hits only: `replaces` lists, migration tests, ADRs
  (ADRs stay as written).

## 6. Verify, commit, deploy

```bash
npm --prefix backend run typecheck && npm --prefix backend test
npm --prefix frontend test && npm --prefix frontend run build
```

Commit the specific files (never `git add -A`), message like `feat: GPT-6.1 Terra replaces
GPT-5.6 Terra` with a body summarising what was verified live. Then `./deploy.sh` and run the
e2e specs that select the model (e.g. `npm run test:e2e -- e2e/openai-models.spec.ts`), plus
the spec for any role whose model changed. Finish with `graphify update .`.

## Report back

Give the user: the probe table, the capability values chosen and why, any role-model
changes made or proposed, surprises (things the card says that the probe contradicted, or
vice versa), and test/e2e results — including anything that failed.
