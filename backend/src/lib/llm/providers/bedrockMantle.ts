// Bedrock Mantle (OpenAI Responses API) ChatProvider — the OpenAI GPT-5.6 counterpart
// to bedrockConverse.ts. Region is single (us-east-1, see config/models.ts), auth
// mirrors bedrockAuth.ts's SigV4-primary/bearer-secondary precedence (see clientFor
// below), and every request is stateless: store:false, no previous_response_id, full
// history replayed each call — required both for cross-provider switching (no server-
// side state to reconcile) and independently by the sensitive-chats posture.
//
// Wire shapes (SSE event names, call_id round-tripping, reasoning payload sizes) were
// empirically confirmed against a real GPT-5.6 model in backend/scripts/mantle-spike.mjs
// before this adapter was written.
import { OpenAI } from 'openai'
import { bedrock } from 'openai/providers/bedrock/aws'
import type {
  ResponseInputItem, ResponseStreamEvent, FunctionTool, Response as MantleResponse,
} from 'openai/resources/responses/responses'
import { getCapabilities, type ModelSettings } from '../../../config/models'
import { ensureBedrockAuth } from '../../bedrockAuth'
import type { StreamChunk, TurnRequest, TurnResult, OnceRequest, OnceResult, ChatProvider, TokenUsage } from '../types'
import type { ToolSpec } from '../toolSpec'
import type { Block, NeutralMessage } from '../blocks'
import { toNeutral, fromNeutralMessages } from './mantleTranslate'

const DEFAULT_REGION = 'us-east-1'

// Reasoning continuity needs `include:['reasoning.encrypted_content']`, since
// store:false means the server keeps nothing. That payload can run large on a
// long multi-round agentic answer against DynamoDB's 400 KB item limit — cap
// what's PERSISTED, not what's replayed within this invocation (see TurnResult
// below). Worst case at the cap is "reasoning doesn't persist across user turns",
// exactly what you'd get with no opaque at all — never a hard failure.
const REASONING_OPAQUE_CAP = 96 * 1024

function capReasoningOpaque(blocks: Block[]): Block[] {
  return blocks.map(b => {
    if (b.kind !== 'thinking' || !b.opaque || b.opaque.data.length <= REASONING_OPAQUE_CAP) return b
    return { kind: 'thinking', text: b.text }
  })
}

function regionFor(modelId: string): string {
  return getCapabilities(modelId).region ?? process.env.OPENAI_BEDROCK_REGION ?? DEFAULT_REGION
}

const clients = new Map<string, OpenAI>()

async function clientFor(region: string): Promise<OpenAI> {
  const cached = clients.get(region)
  if (cached) return cached
  // Memoized SSM read; sets AWS_BEARER_TOKEN_BEDROCK iff BEDROCK_BEARER_TOKEN_SSM is
  // configured. bedrock() below reads it if present, otherwise falls through to the
  // default AWS credential chain (the Lambda's own IAM role) — SigV4, signed as
  // service `bedrock-mantle`. Mirrors bedrockAuth.ts's precedence for Converse.
  await ensureBedrockAuth()
  const bearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK
  const client = new OpenAI({
    provider: bedrock({
      region,
      ...(bearerToken ? { apiKey: bearerToken } : {}),
    }),
  })
  clients.set(region, client)
  return client
}

function toMantleTool(spec: ToolSpec): FunctionTool {
  return { type: 'function', name: spec.name, description: spec.description, parameters: spec.inputSchema, strict: false }
}

// ── ChatProvider implementation ────────────────────────────────────────────────

// Drop any ThinkingBlock whose opaque isn't ours (or is missing) — replaying Claude's
// signature to GPT (or vice-versa) is meaningless and the API has no use for it. Do
// NOT re-emit foreign thinking as assistant text — that would misattribute another
// provider's internal reasoning as this model's own visible output. Then drop any
// message left with zero blocks, and heal a dangling tool_call tail the same way
// Converse's healDanglingToolUse does (mirrors the same interrupted-loop failure mode).
function stripForeignThinking(messages: NeutralMessage[]): NeutralMessage[] {
  return messages
    .map(m => ({ ...m, content: m.content.filter(b => b.kind !== 'thinking' || b.opaque?.provider === 'bedrock-mantle') }))
    .filter(m => m.content.length > 0)
}

function coalesceMessages(messages: NeutralMessage[]): NeutralMessage[] {
  const out: NeutralMessage[] = []
  for (const msg of messages) {
    const prev = out[out.length - 1]
    if (prev && prev.role === msg.role) {
      prev.content = [...prev.content, ...msg.content]
    } else {
      out.push({ ...msg, content: [...msg.content] })
    }
  }
  return out
}

function healDanglingToolCall(messages: NeutralMessage[]): NeutralMessage[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return messages

  const callIds = last.content
    .filter((b): b is Extract<Block, { kind: 'tool_call' }> => b.kind === 'tool_call')
    .map(b => b.callId)
  if (callIds.length === 0) return messages

  const healedTurn: NeutralMessage = {
    role: 'user',
    content: callIds.map(callId => ({
      kind: 'tool_result' as const,
      callId,
      entries: [{ kind: 'text' as const, text: 'Interrupted before completing — please retry.' }],
      isError: true,
    })),
  }
  return [...messages, healedTurn]
}

function sanitizeHistory(messages: NeutralMessage[]): NeutralMessage[] {
  const filtered = stripForeignThinking(messages)
  return healDanglingToolCall(coalesceMessages(filtered))
}

function mapUsage(u: MantleResponse['usage']): TokenUsage | undefined {
  if (!u) return undefined
  // Responses' input_tokens is INCLUSIVE of cached tokens; Converse's excludes them.
  // Subtract here so a mixed-provider chat's transcript totals don't double-count.
  const cacheReadInputTokens = u.input_tokens_details?.cached_tokens ?? 0
  return {
    inputTokens: u.input_tokens - cacheReadInputTokens,
    outputTokens: u.output_tokens,
    ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
    ...(u.input_tokens_details?.cache_write_tokens ? { cacheWriteInputTokens: u.input_tokens_details.cache_write_tokens } : {}),
  }
}

function normalizeStopReason(response: MantleResponse): string {
  if (response.output.some(item => item.type === 'function_call')) return 'tool_use'
  if (response.status === 'incomplete') return 'max_tokens'
  return 'end_turn'
}

function buildReasoningParams(caps: ReturnType<typeof getCapabilities>, settings: ModelSettings) {
  if (caps.thinking !== 'effort' || !settings.thinkingEffort || settings.thinkingEffort === 'off') return {}
  return {
    reasoning: { effort: settings.thinkingEffort, summary: 'auto' as const },
    include: ['reasoning.encrypted_content' as const],
  }
}

async function* streamTurn(req: TurnRequest): AsyncGenerator<StreamChunk, TurnResult> {
  const caps = getCapabilities(req.modelId)
  const region = regionFor(req.modelId)
  const client = await clientFor(region)

  const input: ResponseInputItem[] = fromNeutralMessages(req.messages)
  const tools = req.tools.map(toMantleTool)

  const stream = await client.responses.create({
    model: req.modelId,
    input,
    instructions: req.systemPrompt || undefined,
    stream: true,
    store: false,
    max_output_tokens: caps.maxOutputTokens ?? 16000,
    ...(tools.length > 0 ? { tools, ...(req.forceToolName ? { tool_choice: { type: 'function' as const, name: req.forceToolName } } : {}) } : {}),
    ...buildReasoningParams(caps, req.settings),
  }, ...(req.abortSignal ? [{ signal: req.abortSignal }] : []))

  let finalResponse: MantleResponse | undefined
  let thinkingOpen = false

  for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
    if (event.type === 'response.output_text.delta') {
      if (thinkingOpen) { yield { type: 'thinking_done' }; thinkingOpen = false }
      yield { type: 'delta', text: event.delta }
    } else if (event.type === 'response.reasoning_summary_text.delta') {
      thinkingOpen = true
      yield { type: 'thinking_delta', text: event.delta }
    } else if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
      yield { type: 'tool_call_start', toolUseId: event.item.call_id, name: event.item.name }
    } else if (event.type === 'response.output_item.done') {
      if (event.item.type === 'reasoning' && thinkingOpen) {
        yield { type: 'thinking_done' }
        thinkingOpen = false
      }
      if (event.item.type === 'function_call') {
        yield { type: 'tool_call', toolUseId: event.item.call_id, name: event.item.name, input: event.item.arguments }
      }
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      finalResponse = event.response
    }
  }

  if (!finalResponse) throw new Error('bedrockMantle.streamTurn: no completed response from the stream')

  const content = toNeutral(finalResponse.output)
  return {
    stopReason: normalizeStopReason(finalResponse),
    textContent: finalResponse.output_text ?? '',
    toolUses: finalResponse.output
      .filter((item): item is Extract<typeof item, { type: 'function_call' }> => item.type === 'function_call')
      .map(item => ({ callId: item.call_id, name: item.name, inputJson: item.arguments })),
    // Persisted form drops any oversized reasoning opaque; replayContent carries the
    // full payload for this invocation's next round only (see REASONING_OPAQUE_CAP).
    content: capReasoningOpaque(content),
    replayContent: content,
    usage: mapUsage(finalResponse.usage),
  }
}

async function once(req: OnceRequest): Promise<OnceResult> {
  const caps = getCapabilities(req.modelId)
  const region = regionFor(req.modelId)
  const client = await clientFor(region)
  const input: ResponseInputItem[] = fromNeutralMessages(req.messages)
  const response = await client.responses.create({
    model: req.modelId,
    input,
    instructions: req.systemPrompt || undefined,
    store: false,
    max_output_tokens: req.maxTokens ?? 64,
    ...buildReasoningParams(caps, {}),
  })
  return {
    text: (response.output_text ?? '').trim(),
    usage: mapUsage(response.usage),
  }
}

export const bedrockMantleProvider: ChatProvider = {
  id: 'bedrock-mantle',
  sanitizeHistory,
  streamTurn,
  once,
}
