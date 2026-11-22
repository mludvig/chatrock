# 68. Direct web search with provider escalation

## Status

Accepted.

## Context

AgentCore now exposes Web Search through `InvokeWebSearch`, without an MCP
Gateway. A live comparison of three queries returned the same fifteen URLs in
the same order through the Gateway and direct API. Fourteen snippets were
identical. The direct API was faster in this small sample, retains the same
Amazon index and search price, and removes Gateway calls and infrastructure.

Jina returned substantially different sources: only two of fifteen URLs
overlapped with Amazon in the same-query comparison. It can help when the first
search misses useful evidence. Its existing request also crawled full pages
that the app discarded, although the tool only returns snippets.

## Decision

Replace the Gateway client with the AWS SDK's `InvokeWebSearchCommand`. Use the
deployment region and Lambda execution role, the managed `web-search.v1` tool,
and an explicit five-result limit. Preserve the existing 200-character Amazon
query cap and result-card shape. Remove the Gateway, its connector target,
service role, IAM policy, outputs, and Lambda environment settings.

Amazon is the default starting provider. Existing explicit Jina preferences
remain valid. The preference chooses where to start; an optional `provider`
argument lets the agent use either backend within one conversation, including
research sub-agents. Identify the provider in each result, including automatic
fallbacks. Try the other provider once after an error or empty result. If one
provider fails and the other is empty, state that coverage is incomplete.
Keep the browser fallback when both searches fail or return nothing.

Tool guidance asks the model to refine its query and use the other provider when
results are irrelevant, repetitive, or leave a material question unanswered.
Research can use Jina for wider source coverage, within its existing tool budget.
Do not automatically run both providers after a successful search: deciding
whether nonempty results answer a question requires the agent's judgment.

Request five Jina results with `X-Respond-With: no-content`. Continue to use
`web_fetch` for full pages. Bound Amazon transport waits and Jina search attempts
so a stalled backend can yield to the other provider.

## Consequences

There is no manually provisioned search infrastructure. Deployments must use a
region that supports direct AgentCore Web Search; at launch these are US East
(N. Virginia, Ohio), US West (Oregon), Asia Pacific (Sydney, Tokyo), and Europe
(Ireland). Search result cards and stored tool results keep their existing shape,
with additive provider metadata.

An automatic fallback can add a second billable search. Agent-directed escalation
also consumes another tool round. Model guidance cannot guarantee that every weak
result triggers escalation. Different providers can return overlapping sources;
they do not establish independent corroboration by themselves.

We rejected running both backends for every query because it doubles requests
even when Amazon already answers the question. We rejected retaining the Gateway
because this app does not expose its MCP discovery or enforce fixed domain
policies through it. We deferred an automatic relevance classifier because it
adds another model call and duplicates the research agent's evidence assessment.

The direct API also supports domain and publication-date filters. This migration
does not expose new filtering controls; neither was available in the app's
previous tool interface.
