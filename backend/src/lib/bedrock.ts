import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  ConverseCommand,
  type Message,
  type Tool,
  type ContentBlock,
  type SystemContentBlock,
  type ToolResultBlock,
} from '@aws-sdk/client-bedrock-runtime'
import type { DocumentType } from '@smithy/types'
import { executeTool, WEB_TOOLS, MEMORY_TOOL, MANAGE_PROJECT_MEMORY_TOOL, READ_PROJECT_FILE_TOOL, READ_PROJECT_CHAT_TOOL, BROWSER_TOOL, TAKE_SCREENSHOT_TOOL, GET_RENDERED_PAGE_TOOL, type ToolContext } from './tools'
import { capToolResultText, TOOL_RESULT_CAP, TOOL_RESULTS_ROUND_CAP } from './blocks'
import { getCapabilities, type ModelSettings } from '../config/models'
import { putObjectBytes, signCloudFrontUrl, s3KeyPrefix } from './attachments'

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
 * Gate web tools and memory tool independently.
 */
function buildToolsWithCache(settings: ModelSettings, ctx?: ToolContext): Tool[] {
  const list: Tool[] = []
  if (settings.webSearchEnabled !== false) list.push(...WEB_TOOLS)
  if (settings.browserCoreEnabled !== false) list.push(TAKE_SCREENSHOT_TOOL, GET_RENDERED_PAGE_TOOL)
  if (settings.browserExtendedEnabled === true) list.push(BROWSER_TOOL)
  if (settings.memoryEnabled !== false) list.push(MEMORY_TOOL)
  if (ctx?.projectId && settings.memoryEnabled !== false) list.push(MANAGE_PROJECT_MEMORY_TOOL)
  if (ctx?.projectId) list.push(READ_PROJECT_FILE_TOOL, READ_PROJECT_CHAT_TOOL)
  if (list.length === 0) return []
  return [...list, CACHE_POINT_TOOL]
}

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
function historyHasToolBlocks(messages: Message[]): boolean {
  return messages.some(m =>
    (m.content ?? []).some(b => 'toolUse' in b || 'toolResult' in b)
  )
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
  abortSignal?: AbortSignal,
): AsyncGenerator<StreamChunk, TurnResult> {
  // Only attach toolConfig when there is at least one real toolSpec — a list
  // containing only CACHE_POINT_TOOL (no toolSpec) is treated as empty.
  const hasRealTools = tools.some(t => 'toolSpec' in (t as object))
  const cmd = new ConverseStreamCommand({
    modelId,
    system: buildSystemWithCache(systemPrompt),
    messages,
    ...buildInferenceParams(modelId, settings),
    ...(hasRealTools ? { toolConfig: { tools } } : {}),
  })

  const res = await bedrockClient.send(cmd, ...(abortSignal ? [{ abortSignal }] : []))
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
export const HEARTBEAT_INTERVAL_MS = 4000

export async function* converseStream(
  modelId: string,
  systemPrompt: string,
  messages: Message[],
  settings: ModelSettings = {},
  ctx?: ToolContext,
  abortSignal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  let tools = buildToolsWithCache(settings, ctx)
  // If tools are disabled (both webSearchEnabled and memory off) but the replayed history
  // contains toolUse/toolResult blocks, Bedrock still requires a non-empty toolConfig.
  // Re-offer the full tool set so toolConfig is present and valid for the history.
  if (tools.length === 0 && historyHasToolBlocks(messages)) {
    tools = [...WEB_TOOLS, MEMORY_TOOL, CACHE_POINT_TOOL]
  }
  // Base messages are the incoming history (verbatim blocks replayed as-is).
  // Coalesce adjacent same-role turns so an interrupted agentic loop (which can
  // leave the active leaf on a tool-result user turn) never produces two
  // consecutive user messages → Bedrock ValidationException. Then heal a dangling
  // tool_use tail (the sibling failure mode) the same way.
  const baseMessages: Message[] = healDanglingToolUse(coalesceMessages(messages))
  // New messages added this session (grows with each tool-use round)
  const newMessages: Message[] = []

  let turnIndex = 0

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (abortSignal?.aborted) return
    const builtMessages = buildMessagesWithCache(baseMessages, newMessages)
    const gen = streamOneTurn(modelId, systemPrompt, builtMessages, tools, settings, abortSignal)
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

    if (abortSignal?.aborted) return

    // Execute tools, apply cap helper, build tool-result message
    // A round can fan out many parallel tool_use calls (e.g. the model batching N
    // web_search calls); their results all land in the same DynamoDB turn item, so the
    // per-call cap must shrink as the round grows to keep the aggregate bounded.
    const perCallCap = Math.min(TOOL_RESULT_CAP, Math.floor(TOOL_RESULTS_ROUND_CAP / Math.max(1, result.toolUses.length)))
    // Two representations of the same round's tool results: `toolResultsLive` carries inline
    // image bytes (replayed to Bedrock in the *next* round of this same invocation — nothing
    // re-hydrates `newMessages` mid-loop), `toolResultsPersist` carries S3 locations instead
    // (small, durable — matches how user attachments are stored at rest). Text-only tool
    // results are identical in both and unaffected by this split.
    const toolResultsLive: ContentBlock[] = []
    const toolResultsPersist: ContentBlock[] = []
    for (const tu of result.toolUses) {
      const input = (() => { try { return JSON.parse(tu.inputJson) } catch { return {} } })()
      const toolPromise = executeTool(tu.name, input, ctx ?? { sub: '' })
      let toolResult: ToolResultBlock | undefined
      while (!toolResult) {
        const timerId = { current: undefined as ReturnType<typeof setTimeout> | undefined }
        const outcome = await Promise.race([
          toolPromise.then(r => ({ done: true as const, r })),
          new Promise<{ done: false }>(resolve => { timerId.current = setTimeout(() => resolve({ done: false }), HEARTBEAT_INTERVAL_MS) }),
        ])
        clearTimeout(timerId.current)
        if (outcome.done) {
          toolResult = outcome.r
        } else {
          yield { type: 'heartbeat' }
        }
      }
      const contentBlocks = toolResult.content ?? []
      const textEntries = contentBlocks.filter(c => 'text' in c) as Array<{ text?: string }>
      const imageEntries = contentBlocks.filter(c => 'image' in c) as Array<{ image?: { format?: string; source?: { bytes?: Uint8Array } } }>
      const isError = toolResult.status === 'error'

      // Emit memoryChanged when manage_memory succeeds (triggers WS memoryUpdated event)
      if (tu.name === 'manage_memory' && toolResult.status === 'success') {
        yield { type: 'memoryChanged' as const }
      }

      if (imageEntries.length === 0) {
        // Unchanged path for every text-only tool (web_search, manage_memory, etc.)
        const rawContent = textEntries[0]?.text ?? ''
        const cappedContent = capToolResultText(rawContent, perCallCap)
        yield { type: 'tool_result', toolUseId: tu.toolUseId, name: tu.name, content: cappedContent, isError }
        const block: ContentBlock = { toolResult: { toolUseId: tu.toolUseId, content: [{ text: cappedContent }], status: toolResult.status } }
        toolResultsLive.push(block)
        toolResultsPersist.push(block)
        continue
      }

      // Image-bearing result (e.g. browser screenshots): upload each image to S3 under the
      // same prefix attachments already use (so chat delete/fork already covers them for
      // free), build live (bytes) + persist (s3Location) content arrays, and eagerly sign the
      // uploaded screenshots so the live WS frame can render them with no reload needed.
      // `screenshotUrls` travels as its own StreamChunk field (not embedded in `content`) so
      // the client never has to re-parse a JSON envelope out of a text string.
      const liveContent: NonNullable<ToolResultBlock['content']> = []
      const persistContent: NonNullable<ToolResultBlock['content']> = []
      const screenshotUrls: string[] = []
      const joinedText = textEntries.map(t => t.text ?? '').join('\n\n')
      const cappedText = capToolResultText(joinedText, perCallCap)
      if (cappedText) {
        liveContent.push({ text: cappedText })
        persistContent.push({ text: cappedText })
      }
      for (let i = 0; i < imageEntries.length; i++) {
        const format = imageEntries[i].image?.format ?? 'png'
        const bytes = imageEntries[i].image?.source?.bytes
        if (!bytes) continue
        liveContent.push({ image: { format: format as 'png' | 'jpeg', source: { bytes } } })
        if (ctx?.sub && ctx?.chatId) {
          const key = `${s3KeyPrefix(ctx.sub, ctx.chatId)}browser-${tu.toolUseId}-${i}.${format}`
          const uri = await putObjectBytes(key, bytes, `image/${format}`)
          persistContent.push({ image: { format: format as 'png' | 'jpeg', source: { s3Location: { uri } } } } as unknown as NonNullable<ToolResultBlock['content']>[number])
          screenshotUrls.push(await signCloudFrontUrl(key))
        } else {
          // No durable chat context (e.g. a unit test ctx) — keep bytes in the persisted form
          // too rather than silently dropping the image.
          persistContent.push({ image: { format: format as 'png' | 'jpeg', source: { bytes } } })
        }
      }

      yield { type: 'tool_result', toolUseId: tu.toolUseId, name: tu.name, content: cappedText, isError, screenshotUrls }

      toolResultsLive.push({ toolResult: { toolUseId: tu.toolUseId, content: liveContent, status: toolResult.status } })
      toolResultsPersist.push({ toolResult: { toolUseId: tu.toolUseId, content: persistContent, status: toolResult.status } })
    }

    // Yield the user tool-result turn for persistence (s3Location form)
    yield { type: 'turn', role: 'user', content: toolResultsPersist, turnIndex }
    turnIndex++

    // Continue the loop with the bytes-inline form (this invocation's next round only)
    newMessages.push({ role: 'user', content: toolResultsLive })
    // Loop → next turn with tool results injected
  }

  if (abortSignal?.aborted) return

  // Exhausted tool-use rounds: make one final call. We keep toolConfig present
  // (history contains toolUse/toolResult blocks and Bedrock requires it) but pass
  // the same tools list — the loop is already done after this single call regardless
  // of stopReason, so no infinite-tool-use risk.
  const builtMessages = buildMessagesWithCache(baseMessages, newMessages)
  const finalGen = streamOneTurn(modelId, systemPrompt, builtMessages, tools, settings, abortSignal)
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
  options?: { maxTokens?: number },
): Promise<string> {
  const cmd = new ConverseCommand({
    modelId,
    system: systemPrompt ? [{ text: systemPrompt }] : undefined,
    messages,
    inferenceConfig: { maxTokens: options?.maxTokens ?? 64 },
  })
  const res = await bedrockClient.send(cmd)
  const block = res.output?.message?.content?.[0]
  if (block && 'text' in block) return (block.text ?? '').trim()
  return ''
}
