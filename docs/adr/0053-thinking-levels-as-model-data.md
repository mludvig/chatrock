# 0053. Thinking levels are model data, checked in one place

## Status

Accepted

## Context

GPT always reasons and rejects `effort: 'none'`, while Kimi K3 accepts it. Both run on the Responses provider. The provider had a conditional that turned `off` into `'none'` only when the model's levels included `off`, and otherwise dropped the effort. That mixed two jobs, name translation and level validation, inside one provider, and the frontend already had its own copy of the level check.

## Decision

- `thinkingLevels` in `config/models.ts` is the only statement of which levels a model accepts, and every `thinking:'effort'` model lists them.
- `ws/sendMessage.ts` runs each turn at `supportedEffort(caps, effort)`: the resolved effort if the model offers it, else `defaultSettings(caps)`'s. This is the rule the composer applies.
- The Responses provider only translates names (`off` → `'none'`), unconditionally.

## Consequences

- A stale client or a saved preference asking for a level the model lacks runs at the model's default instead of reaching the API. The turn row records the effort actually used.
- Rejected alternative: a per-model `fixup(request)` function in the registry. It's code in a data table, needs a separate request type per provider, and invites one-off special cases. Every quirk so far is expressible as data. Add a narrowly typed capability field if one ever isn't.
