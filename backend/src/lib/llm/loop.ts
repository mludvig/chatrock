import type { Message, ContentBlock, ToolResultBlock } from '@aws-sdk/client-bedrock-runtime'
import { executeTool, type ToolContext } from '../tools'
import { capToolResultText, TOOL_RESULT_CAP, TOOL_RESULTS_ROUND_CAP } from '../blocks'
import type { ModelSettings } from '../../config/models'
import { putObjectBytes, signCloudFrontUrl, s3KeyPrefix } from '../attachments'
import type { StreamChunk, TurnResult } from './types'
import { coalesceMessages, healDanglingToolUse, historyHasToolBlocks } from './sanitize'
import { buildToolsWithCache, buildMessagesWithCache, streamOneTurn, converseOnce as converseOnceImpl } from './providers/bedrockConverse'
import { WEB_TOOLS, MEMORY_TOOL } from '../tools'

export type { StreamChunk, TokenUsage } from './types'
export { coalesceMessages, healDanglingToolUse } from './sanitize'
export { bedrockClient } from './providers/bedrockConverse'

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
  // Set only for a forced/explicit Search turn (ws/sendMessage.ts) — forces Bedrock toolChoice to
  // this tool name on the FIRST round only (subsequent rounds, if any, are auto-choice as
  // normal). The named tool must already be in `tools` (ctx.searchScope makes buildToolsWithCache
  // include SEARCH_HISTORY_TOOL even when searchEnabled:false) or Bedrock rejects the request.
  forceToolName?: string,
): AsyncGenerator<StreamChunk> {
  let tools = buildToolsWithCache(settings, ctx)
  // If tools are disabled (both webSearchEnabled and memory off) but the replayed history
  // contains toolUse/toolResult blocks, Bedrock still requires a non-empty toolConfig.
  // Re-offer the full tool set so toolConfig is present and valid for the history.
  if (tools.length === 0 && historyHasToolBlocks(messages)) {
    tools = [...WEB_TOOLS, MEMORY_TOOL]
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
    // Forced toolChoice applies to round 0 only — by round 1 the tool has already run and the
    // model is narrating/using its result, which must remain free choice.
    const isForcedRound = round === 0 && !!forceToolName
    // Bedrock rejects toolChoice together with adaptive thinking — the forced round always runs
    // with thinking off (a tool-choice round needs none anyway).
    const roundSettings = isForcedRound ? { ...settings, thinkingEffort: 'off' as const } : settings
    const gen = streamOneTurn(modelId, systemPrompt, builtMessages, tools, roundSettings, abortSignal, isForcedRound ? forceToolName : undefined)
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
        // Text-only tool result. Single-call tools (web_search, manage_memory, etc.) return
        // exactly one text entry, but multi-step browser tools with no screenshot (e.g.
        // get_rendered_page's navigate+snapshot, or browse_web with text-only steps) return
        // one entry per step — join them all, not just the first, or later steps' content
        // (e.g. the actual snapshot YAML) silently disappears.
        const rawContent = textEntries.map(t => t.text ?? '').join('\n\n')
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
          const key = `${s3KeyPrefix(ctx.sub, ctx.chatId)}${tu.name}-${tu.toolUseId}-${i}.${format}`
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
    // Only forward text — tool_call_start/tool_call chunks are swallowed: nothing this
    // round ever executes (see below), so showing the client a tool card with no
    // matching result would leave it spinning forever.
    if (chunk.type === 'delta' || chunk.type === 'thinking_delta') {
      yield chunk
    }
  }

  if (finalResult) {
    if (finalResult.usage) yield { type: 'usage', usage: finalResult.usage }
    // The model may still request a tool here even though nothing will run it. A turn
    // with a toolUse block gets held as "pending" by sendMessage.ts until it's paired
    // with a tool-result turn — which will never come — so it's silently dropped when
    // 'stop' fires right after, ending the chat with no visible or persisted answer.
    // Strip any toolUse blocks and guarantee there's always visible text to persist.
    const finalContent = finalResult.content.filter(b => !('toolUse' in b))
    const hasText = finalContent.some(b => 'text' in b && (b as { text?: string }).text)
    if (!hasText) {
      finalContent.push({ text: "I've reached my research step limit for this turn. Here's what I found before stopping — let me know if you'd like me to continue." })
    }
    yield { type: 'turn', role: 'assistant', content: finalContent, turnIndex }
    yield { type: 'stop', stopReason: finalResult.stopReason === 'tool_use' ? 'max_rounds' : finalResult.stopReason }
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
  return converseOnceImpl(modelId, systemPrompt, messages, options)
}
