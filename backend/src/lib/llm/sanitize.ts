import type { Message } from '@aws-sdk/client-bedrock-runtime'

/**
 * Merge adjacent same-role messages into one, concatenating their content blocks.
 *
 * Bedrock's Converse API requires strictly alternating user/assistant roles. A
 * conversation can legitimately end up with two consecutive same-role turns when
 * an agentic loop is interrupted (e.g. Lambda timeout) right after persisting a
 * tool-result (user-role) turn but before the model consumed it: a subsequent
 * normal user message then chains as [… assistant(toolUse), user(toolResult),
 * user(text)] → two user turns in a row → ValidationException.
 *
 * Coalescing is a no-op for a well-formed alternating history, so it is safe to
 * apply unconditionally as a final guard before every Bedrock call.
 */
export function coalesceMessages(messages: Message[]): Message[] {
  const out: Message[] = []
  for (const msg of messages) {
    const prev = out[out.length - 1]
    if (prev && prev.role === msg.role) {
      prev.content = [...(prev.content ?? []), ...(msg.content ?? [])]
    } else {
      out.push({ ...msg, content: [...(msg.content ?? [])] })
    }
  }
  return out
}

/**
 * If the history ends on an assistant turn with unresolved toolUse blocks (the matching
 * tool-result turn failed to persist, or any other event left the active leaf mid-round),
 * synthesize a placeholder error toolResult for each dangling id so the prefix is valid
 * before it reaches Bedrock — instead of Bedrock rejecting the whole request with a generic
 * ValidationException ("tool_use ids were found without tool_result blocks...").
 *
 * Mirrors coalesceMessages' role: a final defense-in-depth guard, not the primary fix.
 * putMessagePair (sendMessage.ts) prevents new instances of this going forward; this heals
 * any that exist regardless — old data, or any other failure mode that produces the same
 * malformed shape.
 */
export function healDanglingToolUse(messages: Message[]): Message[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return messages

  const toolUseIds = (last.content ?? [])
    .filter(b => 'toolUse' in b)
    .map(b => (b as { toolUse: { toolUseId?: string } }).toolUse.toolUseId)
    .filter((id): id is string => !!id)

  if (toolUseIds.length === 0) return messages

  const healedTurn: Message = {
    role: 'user',
    content: toolUseIds.map(toolUseId => ({
      toolResult: {
        toolUseId,
        content: [{ text: 'Interrupted before completing — please retry.' }],
        status: 'error' as const,
      },
    })),
  }
  return [...messages, healedTurn]
}

/**
 * Return true if any message in the array contains a toolUse or toolResult block.
 * Bedrock requires toolConfig to be present whenever the message history contains
 * these blocks, even if we don't want to offer new tools this turn.
 */
export function historyHasToolBlocks(messages: Message[]): boolean {
  return messages.some(m =>
    (m.content ?? []).some(b => 'toolUse' in b || 'toolResult' in b)
  )
}
