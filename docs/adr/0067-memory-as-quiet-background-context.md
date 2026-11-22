# 67. Use memory as quiet background context

## Status

Accepted.

## Context

Every memory-enabled turn includes saved user and, where enabled, project facts.
The prompt described what the assistant knows without explaining how to use it. Answers repeatedly
introduced personal facts and redirected ordinary questions toward the user's
biography. Project answers also kept announcing the project and why an answer
would be useful to it. Useful personalization became conspicuous and intrusive.

## Decision

Add a shared memory instruction to system-prompt assembly whenever user or project
memory is available. Relevant facts should quietly shape explanations, examples,
language, and defaults. The assistant
should state a remembered fact only when the user asks or when stating it is
necessary to answer the question or explain a material assumption, constraint, or
decision. Current user
statements and instructions take precedence over remembered context.

The instruction also discourages repeatedly naming the project or announcing
"because you are working on" it, repeating facts across answers, copying an
overpersonalized pattern from earlier replies, and narrating unsolicited memory
use or saves. Explicit requests to remember, correct, forget, or recall a fact
still receive a direct response.

## Consequences

The instruction is included once and works even when only project memory is
present. Existing memory data, settings, tools, and privacy gates retain their
behavior.
The instruction applies to every provider through the shared prompt assembler,
including the parent turn that coordinates research.

We rejected removing memory or switching it off because it would lose useful
context. We deferred retrieval filtering because it adds a separate relevance
decision and can discard useful preferences; it also does not govern how a
retrieved fact appears in an answer. We rejected output keyword suppression
because explicit recall and genuinely necessary assumptions must remain possible.

This is model guidance, not a deterministic guarantee. Validate it with real
model responses to unrelated questions, relevant implicit personalization,
explicit recall, and histories that already repeat personal facts.
