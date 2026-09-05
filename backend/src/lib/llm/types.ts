import type { Block, NeutralMessage, ProviderId } from './blocks'
import type { ToolSpec } from './toolSpec'
import type { ModelSettings } from '../../config/models'

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
  // Backend-only: drives per-turn persistence; never sent raw over WS.
  // `content` is the neutral format — this is what lands in DynamoDB verbatim.
  // `truncated` is set only on the final forced-answer turn of the round-budget-exhaustion
  // path (loop.ts) — a distinct signal from `incomplete` (mid-turn abort/error): the model
  // wrote a complete answer, it just ran out of research budget. See
  // docs/adr/0020-research-depth-and-budget-pacing.md.
  | { type: 'turn'; role: 'user' | 'assistant'; content: Block[]; turnIndex: number; truncated?: boolean }
  // Forwarded as a compact WS event for live display
  | { type: 'usage'; usage: TokenUsage }
  // Emitted when manage_memory / manage_project_memory succeeds — triggers memoryUpdated WS
  // event; carries the same op/category/text detail the tool-pill card already shows, so the
  // toast doesn't have to be a content-free "Memory updated".
  | { type: 'memoryChanged'; scope: 'user' | 'project'; operation: string; category?: string; text?: string }
  // Narration from an in-flight run_research_task sub-agent, tagged with the PARENT tool
  // call's toolUseId so the client knows which pill it belongs to. Purely live UI — never
  // persisted, dropping one costs nothing since the finding itself lands as that tool's own
  // tool_result. See docs/adr/0039-deep-research-as-a-sub-agent-tool.md.
  | { type: 'sub_agent_progress'; toolUseId: string; name: string; text: string }

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
}

// ── Call labelling for observability ─────────────────────────────────────────
//
// Every entry point in loop.ts requires an LlmCallContext, so a new call site
// cannot be added without saying what it is for — the wrapper then emits the
// `llm_call` record itself (lib/llm/observability.ts). See
// docs/adr/0029-llm-observability-in-the-wrapper.md.

// A closed union rather than a free string: these values are what CloudWatch
// Insights queries filter on, so a typo'd purpose would silently vanish from them.
export type LlmPurpose =
  | 'chat'
  | 'chat_title'
  | 'chat_summary'
  | 'enrich_user_facts'
  | 'enrich_project_facts'
  | 'extract_user_facts'
  | 'file_summary'
  | 'search_history'
  | 'research_task'

export interface LlmCallContext {
  purpose: LlmPurpose
  sub?: string
  chatId?: string
  projectId?: string
  runId?: string
}

// ── The ChatProvider seam ────────────────────────────────────────────────────
//
// Every model dispatches through one of these (see registry.ts). loop.ts contains
// no provider-specific reasoning at all — everything vendor-specific (cachePoints,
// inference params, toolChoice quirks) lives inside the adapter's streamTurn.

export interface TurnRequest {
  modelId: string
  systemPrompt: string
  // Sanitized history + this invocation's new turns, oldest -> newest.
  messages: NeutralMessage[]
  tools: ToolSpec[]
  settings: ModelSettings
  // Index into `messages` of the last stable-prior message; the adapter places its
  // ONE cache marker at/after it. -1 = nothing stable yet (e.g. a brand new chat).
  cacheBoundaryIndex: number
  abortSignal?: AbortSignal
  // Set only on the first round of a forced/explicit Search turn — the adapter should
  // force tool choice to this tool name for this call only.
  forceToolName?: string
}

export interface OnceRequest {
  modelId: string
  systemPrompt: string
  messages: NeutralMessage[]
  maxTokens?: number
}

// A one-shot call's text plus whatever the provider reported spending on it. `once`
// returns usage rather than just the string so loop.ts can log token stats for the
// non-streaming calls too — `converseOnce`'s own callers still only see the text.
export interface OnceResult {
  text: string
  usage?: TokenUsage
}

export interface TurnResult {
  stopReason: string
  textContent: string
  toolUses: Array<{ callId: string; name: string; inputJson: string }>
  // The form written to DynamoDB.
  content: Block[]
  // Richer form replayed into the NEXT round of THIS invocation only; defaults to
  // `content` when omitted. Lets an adapter carry oversized/live-only material
  // (e.g. inline image bytes, an uncapped reasoning payload) without persisting it.
  replayContent?: Block[]
  usage?: TokenUsage
}

export interface ChatProvider {
  id: ProviderId
  // Runs ONCE per converseStream call, on the incoming replayed history only. Owns
  // whatever history repair (role-coalescing, dangling-tool-call healing) and
  // foreign-opaque filtering this provider's wire format requires. Idempotent.
  sanitizeHistory(messages: NeutralMessage[]): NeutralMessage[]
  streamTurn(req: TurnRequest): AsyncGenerator<StreamChunk, TurnResult>
  once(req: OnceRequest): Promise<OnceResult>
}
