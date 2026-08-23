# 0029 — LLM observability lives in the wrapper, not at call sites

## Status

Accepted.

## Context

`llm_call` CloudWatch records were written by hand at three call sites (`ws/sendMessage.ts`,
`http/projects.ts`, and an `enrich_turn` line covering enrichment). Every other LLM call —
enrichment's four calls, memory extraction, search ranking, file summaries, and all four Deep
Research phases — emitted nothing, so the token-heaviest work in the system was invisible in
CloudWatch. Nothing about adding a new call site prompted anyone to add a log line.

## Decision

`lib/llm/loop.ts` is the only place an `llm_call` record is emitted. Both entry points take a
required `call: LlmCallContext` (`purpose` from a closed `LlmPurpose` union, plus optional
`sub`/`chatId`/`projectId`/`runId`), and `lib/llm/observability.ts`'s `logLlmCall` writes one
record per invocation with model, provider, `ok`, `durationMs`, the correlation ids, round
count, stop reason, summed token usage and any error. `converseStream` is a thin generator
shell around the agentic loop that logs in a `finally`, so an abort, an early consumer
`break`, or a throw all still produce exactly one record. `converseStream`'s trailing
positional parameters became one options object to carry `call` without a seventh positional
argument. `ChatProvider.once` widened to return `{ text, usage }` so one-shot calls report
token stats too; `converseOnce` still returns just the string to its callers.

## Consequences

A new LLM call site cannot be added without labelling itself, and gets identical logging for
free. All twelve purposes — including the four research phases — are now queryable with one
CloudWatch Insights filter on `event = "llm_call"`, discriminated by `ok`.

Rejected: carrying `purpose` on `ToolContext`, which would have cost no test churn but
overloads a tool-execution type with call metadata and leaves `converseStream`'s positional
signature at its limit for the next field that needs threading. Rejected: keeping the logging
at call sites and just adding the missing ones — that is the state this replaces, and it
regresses the moment a new call site is written.
