import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime'

// ── Stream chunk types sent back over WebSocket ───────────────────────────────
//
// Provider-agnostic: every ChatProvider (bedrock-converse today, bedrock-mantle
// later) yields this same shape from streamTurn(), and ws/sendMessage.ts only
// ever sees this union — never a provider's native wire events.

export type StreamChunk =
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_done' }
  | { type: 'delta'; text: string }
  | { type: 'tool_call_start'; toolUseId: string; name: string }
  | { type: 'tool_call'; toolUseId: string; name: string; input: string }
  | { type: 'tool_result'; toolUseId: string; name: string; content: string; isError: boolean; screenshotUrls?: string[] }
  // Sent periodically while a single tool call is in flight for longer than a few seconds
  // (e.g. browse_web's AgentCore session) so the WebSocket carries real traffic during an
  // otherwise-silent gap — observed empirically to reduce the WS connection going stale.
  | { type: 'heartbeat' }
  | { type: 'stop'; stopReason: string }
  // Backend-only: drives per-turn persistence; never sent raw over WS
  | { type: 'turn'; role: 'user' | 'assistant'; content: ContentBlock[]; turnIndex: number }
  // Forwarded as a compact WS event for live display
  | { type: 'usage'; usage: TokenUsage }
  // Emitted when manage_memory tool succeeds — triggers memoryUpdated WS event
  | { type: 'memoryChanged' }

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
}

// ── Internal streaming result for one provider turn ────────────────────────────

export interface TurnResult {
  stopReason: string
  textContent: string
  toolUses: Array<{ toolUseId: string; name: string; inputJson: string }>
  // Verbatim assembled ContentBlock[] in arrival order (for persistence)
  content: ContentBlock[]
  usage?: TokenUsage
}
