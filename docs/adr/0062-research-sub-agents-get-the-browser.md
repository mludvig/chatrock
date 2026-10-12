# 0062 — Research sub-agents get the core browser tools

## Status

Accepted. Changes the "web tools only" researcher tool set in 0039.

## Context

Deep research sub-agents do most of a deep turn's web reading, but ran with the browser off,
so a page Jina couldn't read (bot wall, JavaScript-rendered) was a dead end for them.
Nothing required this; the settings were carried over from an earlier researcher
implementation.

## Decision

A researcher gets `get_rendered_page` and `take_screenshot` when its parent turn has them
(`ToolContext.browserAvailable`), so turning the browser off for a chat also turns it off for
that chat's researchers. `browse_web` stays off. Screenshots are kept because the sub-agent's
own model reads the image, which helps on pages with little text.

## Consequences

- A deep turn can open up to about 30 browser sessions at once (6 sub-agents × 5 parallel
  tools), within AgentCore's 1000 concurrent sessions but close to its 30/s start rate.
- Browser sessions take 10–20s each and count against the turn's wall-clock deadline.
- Rejected: `get_rendered_page` only (screenshots help on image-heavy pages and only cost
  image tokens); always on (ignores the chat's browser setting).
