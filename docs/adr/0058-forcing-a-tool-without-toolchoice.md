# 0058. Forcing a tool on a model that rejects forced toolChoice

## Status

Accepted

## Context

A Search turn forces `search_history` on its first round through Converse `toolChoice: { tool }`. Sonnet 5.5, Opus 5.5 and Fable 5.1 reject that ("tool_choice type tool/any not supported"), so on those models a Search turn failed outright.

## Decision

A `forcedToolChoice: false` model capability marks these models. On a forced round, `bedrockConverse.streamTurn` offers such a model only the forced tool and sends no `toolChoice`. Later rounds get the full tool list as usual. Thinking stays at the requested level, because the clash between thinking and toolChoice doesn't arise without a toolChoice.

## Consequences

Search turns work on every model. On these models the tool call is strongly steered rather than guaranteed: the model can still answer without calling the only tool it has. The forced round's tool list differs from the cached one, so that one round misses the tool-definition cache.

Alternatives rejected:

- **`toolChoice: any`.** Rejected by the same models.
- **A system-prompt instruction alone.** It still offers every other tool, which is a weaker steer than a list of one.
- **Running `search_history` server-side and injecting the result.** It bypasses the model's own query, and the query is the useful part of the tool call.
