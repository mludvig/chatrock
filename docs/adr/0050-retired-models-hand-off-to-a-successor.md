# 0050 — Retired models hand off to a successor

## Status

Accepted (2026-09-23). Amends the retired-model consequence of [0048](0048-openai-models-on-bedrock-runtime.md).

## Context

A chat whose model was retired fell back to `DEFAULT_CHAT_MODEL`, so an Opus or GPT-5.6 Luna chat quietly became a Sonnet chat when its model got a newer version. Users expect a chat to stay in its model family.

## Decision

Each `Model` in `config/models.ts` can list the retired IDs it `replaces`. A stored ID resolves to itself if it is still live, then to the model that replaces it, then to `DEFAULT_CHAT_MODEL`. When a successor is itself retired, its ID and its `replaces` list move to the new model, so each lookup is a single step. A unit test checks that no live ID is listed and no ID appears in two lists. Resolution happens on reads only, as in [0049](0049-sort-chats-by-last-message-and-save-composer-choices-on-send.md): the chat row changes when its next message is sent. `sendMessage` also resolves a retired ID, so a tab with an old model list still works. User and project `defaultModel` read as the successor, or as unset when there is none, so an old default doesn't become a pinned Sonnet.

## Consequences

Retiring a model means deleting its entry and adding its ID to the successor's list, which is data only. The family link must be declared by hand for each retirement.

Alternatives considered:

- A `family` field: once the old entry is deleted, nothing records which family an old ID belonged to.
- A separate alias map: works the same way, but keeps the rule away from the model it describes.
- Keeping retired entries as hidden "deprecated" models: the registry keeps growing, and every model list would need to filter them out.
