// Bedrock Responses (OpenAI Responses API on bedrock-runtime) ChatProvider — the OpenAI
// GPT counterpart to bedrockConverse.ts. Same region and IAM surface as Converse (a
// global.* inference profile called from bedrockRegion()), auth mirrors bedrockAuth.ts's
// SigV4-primary/bearer-secondary precedence (see getClient below), and every request is
// stateless: store:false, no previous_response_id, full history replayed each call —
// required both for cross-provider switching (no server-side state to reconcile) and
// independently by the sensitive-chats posture.
// See docs/adr/0048-openai-models-on-bedrock-runtime.md.
import { OpenAI } from 'openai'
import { bedrock } from 'openai/providers/bedrock/aws'
import type {
  ResponseInputItem, ResponseStreamEvent, FunctionTool, Response as OpenAIResponse,
} from 'openai/resources/responses/responses'
import { getCapabilities, type ModelSettings } from '../../../config/models'
import { ensureBedrockAuth, bedrockRegion } from '../../bedrockAuth'
import type { StreamChunk, TurnRequest, TurnResult, OnceRequest, OnceResult, ChatProvider, TokenUsage } from '../types'
import type { ToolSpec } from '../toolSpec'
import type { Block, NeutralMessage } from '../blocks'
import { toNeutral, fromNeutralMessages } from './responsesTranslate'

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

let client: OpenAI | undefined

async function getClient(): Promise<OpenAI> {
  if (client) return client
  // Memoized SSM read; sets AWS_BEARER_TOKEN_BEDROCK iff BEDROCK_BEARER_TOKEN_SSM is
  // configured. bedrock() below reads it if present, otherwise falls through to the
  // default AWS credential chain (the Lambda's own IAM role) — SigV4, signed as
  // service `bedrock`. Mirrors bedrockAuth.ts's precedence for Converse.
  await ensureBedrockAuth()
  const bearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK
  client = new OpenAI({
    provider: bedrock({
      region: bedrockRegion(),
      endpoint: 'runtime',
      ...(bearerToken ? { apiKey: bearerToken } : {}),
    }),
  })
  return client
}

function toResponsesTool(spec: ToolSpec): FunctionTool {
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
    .map(m => ({ ...m, content: m.content.filter(b => b.kind !== 'thinking' || b.opaque?.provider === 'bedrock-responses') }))
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

function mapUsage(u: OpenAIResponse['usage']): TokenUsage | undefined {
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

function normalizeStopReason(response: OpenAIResponse): string {
  if (response.output.some(item => item.type === 'function_call')) return 'tool_use'
  if (response.status === 'incomplete') return 'max_tokens'
  return 'end_turn'
}

function buildReasoningParams(caps: ReturnType<typeof getCapabilities>, settings: ModelSettings) {
  if (caps.thinking !== 'effort' || !settings.thinkingEffort) return {}
  if (settings.thinkingEffort === 'off') {
    // Only a model that offers 'off' can switch reasoning off; for the rest (GPT) 'off' means the API default.
    return caps.thinkingLevels?.includes('off') === false ? {} : { reasoning: { effort: 'none' as const } }
  }
  return {
    reasoning: { effort: settings.thinkingEffort, summary: 'auto' as const },
    include: ['reasoning.encrypted_content' as const],
  }
}

function isCrossRegionReasoningError(err: unknown): boolean {
  return (err as { status?: number }).status === 400
    && /encrypted content cannot be used in a different region/i.test((err as Error).message)
}

async function* streamTurn(req: TurnRequest): AsyncGenerator<StreamChunk, TurnResult> {
  const caps = getCapabilities(req.modelId)
  const client = await getClient()

  const input: ResponseInputItem[] = fromNeutralMessages(req.messages)
  const tools = req.tools.map(toResponsesTool)

  const create = (input: ResponseInputItem[]) => client.responses.create({
    model: req.modelId,
    input,
    instructions: req.systemPrompt || undefined,
    stream: true,
    store: false,
    max_output_tokens: caps.maxOutputTokens ?? 16000,
    ...(tools.length > 0 ? { tools, ...(req.forceToolName ? { tool_choice: { type: 'function' as const, name: req.forceToolName } } : {}) } : {}),
    ...buildReasoningParams(caps, req.settings),
  }, ...(req.abortSignal ? [{ signal: req.abortSignal }] : []))

  let stream
  try {
    stream = await create(input)
  } catch (err) {
    if (!isCrossRegionReasoningError(err)) throw err
    // Encrypted reasoning only decrypts in the region that produced it, and a global.* profile
    // may route this call elsewhere — retry without it. See docs/adr/0052-cross-region-encrypted-reasoning.md.
    stream = await create(input.filter(item => item.type !== 'reasoning'))
  }

  let finalResponse: OpenAIResponse | undefined
  let thinkingOpen = false

  for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
    if (event.type === 'response.output_text.delta') {
      if (thinkingOpen) { yield { type: 'thinking_done' }; thinkingOpen = false }
      yield { type: 'delta', text: event.delta }
    } else if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_text.delta') {
      // GPT streams a reasoning summary; Kimi K3 streams its raw reasoning text instead.
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

  if (!finalResponse) throw new Error('bedrockResponses.streamTurn: no completed response from the stream')

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
  const client = await getClient()
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

export const bedrockResponsesProvider: ChatProvider = {
  id: 'bedrock-responses',
  sanitizeHistory,
  streamTurn,
  once,
}
