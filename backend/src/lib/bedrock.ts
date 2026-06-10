import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  ConverseCommand,
  type Message,
  type Tool,
  type ContentBlock,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime'
import type { DocumentType } from '@smithy/types'
import { executeTool, WEB_TOOLS } from './tools'
import { capToolResultText } from './blocks'
import { getCapabilities, type ModelSettings } from '../config/models'

export const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION ?? 'ap-southeast-2',
})

// ── Stream chunk types sent back over WebSocket ───────────────────────────────

export type StreamChunk =
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_done' }
  | { type: 'delta'; text: string }
  | { type: 'tool_call_start'; toolUseId: string; name: string }
  | { type: 'tool_call'; toolUseId: string; name: string; input: string }
  | { type: 'tool_result'; toolUseId: string; name: string; content: string; isError: boolean }
  | { type: 'stop'; stopReason: string }
  // Backend-only: drives per-turn persistence; never sent raw over WS
  | { type: 'turn'; role: 'user' | 'assistant'; content: ContentBlock[]; turnIndex: number }
  // Forwarded as a compact WS event for live display
  | { type: 'usage'; usage: TokenUsage }

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
}

// ── Internal streaming for one Bedrock turn ──────────────────────────────────

interface TurnResult {
  stopReason: string
  textContent: string
  toolUses: Array<{ toolUseId: string; name: string; inputJson: string }>
  // Verbatim assembled ContentBlock[] in arrival order (for persistence)
  content: ContentBlock[]
  usage?: TokenUsage
}

function buildInferenceParams(modelId: string, settings: ModelSettings) {
  const caps = getCapabilities(modelId)
  const thinkingActive = caps.thinking !== 'none' && settings.thinkingEffort && settings.thinkingEffort !== 'off'

  // Temperature and topP must be omitted when thinking is active (API requirement)
  const inferenceConfig: Record<string, unknown> = { maxTokens: 16000 }
  if (!thinkingActive) {
    if (caps.temperature && settings.temperature !== undefined) inferenceConfig.temperature = settings.temperature
    if (caps.topP && settings.topP !== undefined) inferenceConfig.topP = settings.topP
  }

  const additionalFields: DocumentType = {}
  if (caps.topK && settings.topK !== undefined) (additionalFields as Record<string, DocumentType>).top_k = settings.topK
  if (thinkingActive && caps.thinking === 'adaptive') {
    (additionalFields as Record<string, DocumentType>).thinking = { type: 'adaptive' } as DocumentType
    ;(additionalFields as Record<string, DocumentType>).output_config = { effort: settings.thinkingEffort ?? 'low' } as DocumentType
  }

  return {
    inferenceConfig,
    ...(Object.keys(additionalFields as object).length > 0 ? { additionalModelRequestFields: additionalFields } : {}),
  }
}

// The Bedrock SDK uses discriminated unions for Tool / SystemContentBlock /
// ContentBlock — cachePoint is a valid member but TypeScript's structural
// typing requires a cast to the base interface type.
const CACHE_POINT_TOOL    = { cachePoint: { type: 'default' as const } } as unknown as Tool
const CACHE_POINT_SYSTEM  = { cachePoint: { type: 'default' as const } } as unknown as SystemContentBlock
const CACHE_POINT_CONTENT = { cachePoint: { type: 'default' as const } } as unknown as ContentBlock

/**
 * Build the tools list with a trailing cachePoint so the tool definitions
 * (which are stable across all turns) get cached on first use.
 */
function buildToolsWithCache(): Tool[] {
  return [...WEB_TOOLS, CACHE_POINT_TOOL]
}

/**
 * Build the system prompt array with a trailing cachePoint.
 * Returns undefined when systemPrompt is empty (no dangling cachePoint).
 */
function buildSystemWithCache(systemPrompt: string): SystemContentBlock[] | undefined {
  if (!systemPrompt) return undefined
  return [
    { text: systemPrompt } as SystemContentBlock,
    CACHE_POINT_SYSTEM,
  ]
}

/**
 * Derive the messages array for a given round, injecting ONE trailing
 * cachePoint on the last stable prior message (everything before the
 * messages added in this round).  Re-derived each round so the cachePoint
 * REPLACES (not accumulates) as the conversation grows.
 *
 * @param baseMessages  — the full conversation history (prior turns only;
 *                        does NOT include the turn currently being generated)
 * @param newMessages   — turns added in this round (assistant + toolResult);
 *                        empty on the first round
 */
function buildMessagesWithCache(baseMessages: Message[], newMessages: Message[]): Message[] {
  if (baseMessages.length === 0 && newMessages.length === 0) return []

  if (newMessages.length === 0) {
    // First round: inject a cachePoint on the last block of the last prior message
    return injectTrailingCachePoint(baseMessages)
  }

  // Subsequent rounds: prior stable messages keep their cachePoint; new turns
  // appended without one (they become the "stable prior" next round)
  return [...injectTrailingCachePoint(baseMessages), ...newMessages]
}

/**
 * Return a copy of messages with a cachePoint injected after the last block
 * of the last message.  The original array is never mutated.
 */
function injectTrailingCachePoint(messages: Message[]): Message[] {
  if (messages.length === 0) return []
  const last = messages[messages.length - 1]
  const content = last.content ?? []
  const withCache = [...content, CACHE_POINT_CONTENT]
  return [
    ...messages.slice(0, -1),
    { ...last, content: withCache },
  ]
}

async function* streamOneTurn(
  modelId: string,
  systemPrompt: string,
  messages: Message[],
  tools: Tool[],
  settings: ModelSettings,
): AsyncGenerator<StreamChunk, TurnResult> {
  const cmd = new ConverseStreamCommand({
    modelId,
    system: buildSystemWithCache(systemPrompt),
    messages,
    ...buildInferenceParams(modelId, settings),
    ...(tools.length > 0 ? { toolConfig: { tools } } : {}),
  })

  const res = await bedrockClient.send(cmd)
  if (!res.stream) throw new Error('No stream in Bedrock response')

  let stopReason = 'end_turn'
  let textContent = ''
  let usage: TokenUsage | undefined

  // Per-block-index accumulator for verbatim ContentBlock reconstruction
  type BlockAcc =
    | { kind: 'thinking'; textParts: string[]; signature: string | undefined; redactedContent: Uint8Array | undefined }
    | { kind: 'text'; textParts: string[] }
    | { kind: 'toolUse'; toolUseId: string; name: string; inputJson: string }

  const blockAcc: Record<number, BlockAcc> = {}
  const toolUses: Array<{ toolUseId: string; name: string; inputJson: string }> = []

  for await (const event of res.stream) {
    // Block start — record what type this block index is
    if (event.contentBlockStart) {
      const idx = event.contentBlockStart.contentBlockIndex ?? 0
      const start = event.contentBlockStart.start
      if (start?.toolUse) {
        blockAcc[idx] = { kind: 'toolUse', toolUseId: start.toolUse.toolUseId ?? '', name: start.toolUse.name ?? '', inputJson: '' }
        yield { type: 'tool_call_start', toolUseId: start.toolUse.toolUseId ?? '', name: start.toolUse.name ?? '' }
      } else {
        // Text block by default; may become thinking on first reasoningContent delta
        blockAcc[idx] = { kind: 'text', textParts: [] }
      }
    }

    // Block delta
    if (event.contentBlockDelta) {
      const idx = event.contentBlockDelta.contentBlockIndex ?? 0
      const delta = event.contentBlockDelta.delta

      if (delta?.text) {
        // Defensive: Bedrock may not always fire contentBlockStart before the
        // first delta for a plain text block.  Create the accumulator on-the-fly
        // so text is captured in the persisted `turn` chunk's content[].
        if (!blockAcc[idx]) {
          blockAcc[idx] = { kind: 'text', textParts: [] }
        }
        const acc = blockAcc[idx]
        if (acc.kind === 'thinking') {
          yield { type: 'thinking_delta', text: delta.text }
          acc.textParts.push(delta.text)
        } else if (acc.kind === 'text') {
          textContent += delta.text
          yield { type: 'delta', text: delta.text }
          acc.textParts.push(delta.text)
        }
      } else if (delta?.reasoningContent) {
        // Upgrade block to thinking on first reasoning delta
        let acc = blockAcc[idx]
        if (acc?.kind !== 'thinking') {
          acc = { kind: 'thinking', textParts: [], signature: undefined, redactedContent: undefined }
          blockAcc[idx] = acc
        }
        const thinkAcc = acc as Extract<BlockAcc, { kind: 'thinking' }>

        if (delta.reasoningContent.text !== undefined) {
          thinkAcc.textParts.push(delta.reasoningContent.text)
          yield { type: 'thinking_delta', text: delta.reasoningContent.text }
        }
        if (delta.reasoningContent.signature !== undefined) {
          thinkAcc.signature = delta.reasoningContent.signature
        }
        if (delta.reasoningContent.redactedContent !== undefined) {
          thinkAcc.redactedContent = delta.reasoningContent.redactedContent as Uint8Array
        }
      } else if (delta?.toolUse?.input) {
        const acc = blockAcc[idx]
        if (acc?.kind === 'toolUse') acc.inputJson += delta.toolUse.input
      }
    }

    // Block stop — emit UI events + finalise the block in blockAcc
    if (event.contentBlockStop) {
      const idx = event.contentBlockStop.contentBlockIndex ?? 0
      const acc = blockAcc[idx]
      if (acc?.kind === 'thinking') {
        yield { type: 'thinking_done' }
      }
      if (acc?.kind === 'toolUse') {
        const tu = { toolUseId: acc.toolUseId, name: acc.name, inputJson: acc.inputJson }
        toolUses.push(tu)
        yield { type: 'tool_call', toolUseId: tu.toolUseId, name: tu.name, input: tu.inputJson }
      }
    }

    // Message stop
    if (event.messageStop) {
      stopReason = event.messageStop.stopReason ?? 'end_turn'
    }

    // Usage metadata — emit a usage chunk
    if (event.metadata?.usage) {
      const u = event.metadata.usage
      usage = {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        ...(u.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: u.cacheReadInputTokens } : {}),
        ...(u.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: u.cacheWriteInputTokens } : {}),
      }
      yield { type: 'usage', usage }
    }
  }

  // Build verbatim content[] by block index order
  const content: ContentBlock[] = []
  const blockIndices = Object.keys(blockAcc).map(Number).sort((a, b) => a - b)
  for (const idx of blockIndices) {
    const acc = blockAcc[idx]
    if (acc.kind === 'thinking') {
      if (acc.redactedContent !== undefined) {
        content.push({ reasoningContent: { redactedContent: acc.redactedContent } })
      } else {
        content.push({
          reasoningContent: {
            reasoningText: {
              text: acc.textParts.join(''),
              signature: acc.signature ?? '',
            },
          },
        })
      }
    } else if (acc.kind === 'text') {
      const text = acc.textParts.join('')
      if (text) content.push({ text })
    } else if (acc.kind === 'toolUse') {
      content.push({
        toolUse: {
          toolUseId: acc.toolUseId,
          name: acc.name,
          input: (() => { try { return JSON.parse(acc.inputJson) } catch { return {} } })(),
        },
      })
    }
  }

  return { stopReason, textContent, toolUses, content, usage }
}

// ── Public: full agentic streaming loop with tool use ────────────────────────

// Maximum number of tool-use rounds before we force a final text answer
const MAX_TOOL_ROUNDS = 8

export async function* converseStream(
  modelId: string,
  systemPrompt: string,
  messages: Message[],
  settings: ModelSettings = {},
): AsyncGenerator<StreamChunk> {
  const tools = buildToolsWithCache()
  // Base messages are the incoming history (verbatim blocks replayed as-is)
  const baseMessages: Message[] = [...messages]
  // New messages added this session (grows with each tool-use round)
  const newMessages: Message[] = []

  let turnIndex = 0

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const builtMessages = buildMessagesWithCache(baseMessages, newMessages)
    const gen = streamOneTurn(modelId, systemPrompt, builtMessages, tools, settings)
    let result: TurnResult | undefined

    // Drain the generator, forwarding UI chunks to caller
    while (true) {
      const { value, done } = await gen.next()
      if (done) {
        result = value as TurnResult
        break
      }
      const chunk = value as StreamChunk
      // Forward all UI chunks except 'turn' and 'usage' (we re-emit usage below)
      if (chunk.type !== 'turn' && chunk.type !== 'usage') {
        yield chunk
      }
    }

    if (!result) break

    // Yield usage first (so sendMessage.ts can read lastUsage before processing turn)
    if (result.usage) yield { type: 'usage', usage: result.usage }
    // Yield the verbatim assistant turn for persistence
    yield { type: 'turn', role: 'assistant', content: result.content, turnIndex }
    turnIndex++

    if (result.stopReason !== 'tool_use' || result.toolUses.length === 0) {
      yield { type: 'stop', stopReason: result.stopReason }
      return
    }

    // Build the assistant message for this round (verbatim content from turn)
    newMessages.push({ role: 'assistant', content: result.content })

    // Execute tools, apply cap helper, build tool-result message
    const toolResults: ContentBlock[] = []
    for (const tu of result.toolUses) {
      const input = (() => { try { return JSON.parse(tu.inputJson) } catch { return {} } })()
      const toolResult = await executeTool(tu.name, input)
      const rawContent = toolResult.content?.[0] && 'text' in toolResult.content[0]
        ? (toolResult.content[0].text ?? '')
        : ''
      // Cap BEFORE storing (so stored == sent → cache-safe, no replay drift)
      const cappedContent = capToolResultText(rawContent)
      const isError = toolResult.status === 'error'

      yield { type: 'tool_result', toolUseId: tu.toolUseId, name: tu.name, content: cappedContent, isError }

      toolResults.push({
        toolResult: {
          toolUseId: tu.toolUseId,
          content: [{ text: cappedContent }],
          status: toolResult.status,
        },
      })
    }

    // Yield the user tool-result turn for persistence
    yield { type: 'turn', role: 'user', content: toolResults, turnIndex }
    turnIndex++

    newMessages.push({ role: 'user', content: toolResults })
    // Loop → next turn with tool results injected
  }

  // Exhausted tool-use rounds: make one final call with no tools so the model
  // must produce a text answer rather than keep requesting tool use.
  const builtMessages = buildMessagesWithCache(baseMessages, newMessages)
  const finalGen = streamOneTurn(modelId, systemPrompt, builtMessages, [], settings)
  let finalResult: TurnResult | undefined

  while (true) {
    const { value, done } = await finalGen.next()
    if (done) {
      finalResult = value as TurnResult
      break
    }
    const chunk = value as StreamChunk
    if (chunk.type !== 'turn' && chunk.type !== 'usage') {
      yield chunk
    }
  }

  if (finalResult) {
    if (finalResult.usage) yield { type: 'usage', usage: finalResult.usage }
    yield { type: 'turn', role: 'assistant', content: finalResult.content, turnIndex }
    yield { type: 'stop', stopReason: finalResult.stopReason }
  } else {
    yield { type: 'stop', stopReason: 'max_rounds' }
  }
}

// ── One-shot non-streaming call (used for title generation) ──────────────────

export async function converseOnce(
  modelId: string,
  systemPrompt: string,
  messages: Message[],
): Promise<string> {
  const cmd = new ConverseCommand({
    modelId,
    system: systemPrompt ? [{ text: systemPrompt }] : undefined,
    messages,
    inferenceConfig: { maxTokens: 64 },
  })
  const res = await bedrockClient.send(cmd)
  const block = res.output?.message?.content?.[0]
  if (block && 'text' in block) return (block.text ?? '').trim()
  return ''
}
