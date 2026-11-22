# 0070: Recover incompatible signed and encrypted reasoning

## Status

Accepted.

## Context

Anthropic thinking signatures bind a block to its preceding conversation.
Replaying persisted turns can change that prefix: research pacing instructions
are transient, tool results may use persisted rather than live representations,
and continuation requests may coalesce adjacent assistant messages. A continued
multi-round Opus response failed with the provider's explicit prefix-mismatch
validation error. A short continuation without tool rounds did not expose this.

A same-region cross-account spike also reproduced GPT-6.1 Sol's
`400 invalid encrypted view`. The same-model reasoning replay succeeded within
the source account; in the destination account it succeeded only when encrypted
reasoning was removed. Opus's signed reasoning replay succeeded across those
accounts in this spike.

## Decision

On the explicit thinking-block prefix-binding rejection, retry the provider
request once using its advertised `thinking-binding-controls-2026-08-01` beta and
`thinking.block_binding.prefix_mismatch_behavior: drop_block` setting. Retry only
before any output and while the request is not cancelled.

Let the provider discard incompatible thinking blocks. Keep canonical stored
blocks, signatures, answer text, and tool results unchanged. Matching thinking
blocks remain available to the provider. Other signature errors still fail.

Extend the Responses adapter's existing one-time replay without reasoning to the
observed `400 invalid encrypted view` error. Require reasoning input and an
uncancelled request. Preserve every non-reasoning input item and do not retry
unrelated failures or repeat the stripped retry.

## Consequences

Existing affected conversations can continue without a data migration. The
rejected request adds a validation round trip; output budgets stay unchanged.
Recovery cannot loop or duplicate output.

Dropping all thinking during every replay was rejected because it discards valid
reasoning too. Reconstructing every historical live prefix was rejected because
old records do not contain all transient content. The provider's specific
recovery control handles that mismatch without guessing or rewriting history.
