import { executeTool, type ToolContext } from '../tools'
import {
  capToolResultText, TOOL_RESULT_CAP, TOOL_RESULTS_ROUND_CAP,
  type Block, type NeutralMessage, type ToolResultEntry as NeutralToolResultEntry,
} from './blocks'
import type { ModelSettings } from '../../config/models'
import { putObjectBytes, signCloudFrontUrl, s3KeyPrefix } from '../attachments'
import type { StreamChunk, TurnResult } from './types'
import { getProvider } from './registry'
import { buildToolList } from './toolGating'

export type { StreamChunk, TokenUsage } from './types'
export { coalesceMessages, healDanglingToolUse } from './sanitize'
export { bedrockClient } from './providers/bedrockConverse'

// Tool-round budget per research depth. Absent settings.researchDepth -> 'brief'; 'deep'
// is accepted by the ModelSettings type but not yet routed to a distinct mode (Phase 3),
// so it currently runs at the 'extended' budget. See docs/adr/0020-research-depth-and-budget-pacing.md.
export const ROUND_BUDGETS: Record<'brief' | 'extended', number> = { brief: 3, extended: 8 }
export const HEARTBEAT_INTERVAL_MS = 4000
// Max concurrent tool executions within a single round — see docs/adr/0016-parallel-tool-execution.md.
const TOOL_CONCURRENCY = 5

export async function* converseStream(
  modelId: string,
  systemPrompt: string,
  messages: NeutralMessage[],
  settings: ModelSettings = {},
  ctx?: ToolContext,
  abortSignal?: AbortSignal,
  // Set only for a forced/explicit Search turn (ws/sendMessage.ts) — forces the
  // provider's toolChoice to this tool name on the FIRST round only (subsequent
  // rounds, if any, are auto-choice as normal). The named tool must already be in
  // `tools` (ctx.searchScope makes buildToolList include SEARCH_HISTORY_TOOL even
  // when searchEnabled:false) or the provider rejects the request.
  forceToolName?: string,
): AsyncGenerator<StreamChunk> {
  const provider = getProvider(modelId)
  const tools = buildToolList(settings, ctx)
  const maxRounds = ROUND_BUDGETS[settings.researchDepth === 'extended' || settings.researchDepth === 'deep' ? 'extended' : 'brief']

  // Sanitize the incoming replayed history ONCE per invocation — coalesce/heal plus
  // foreign-opaque filtering are the provider's business (see ChatProvider.sanitizeHistory).
  const sanitized = provider.sanitizeHistory(messages)
  // Index of the last stable-prior message; the adapter places its ONE cache marker
  // at/after it. Fixed for the whole invocation — `sanitized` never changes below,
  // only `newMessages` grows, so this stays a stable position across all rounds.
  const cacheBoundaryIndex = sanitized.length - 1
  // New messages added this session (grows with each tool-use round).
  const newMessages: NeutralMessage[] = []

  let turnIndex = 0

  for (let round = 0; round < maxRounds; round++) {
    if (abortSignal?.aborted) return
    const builtMessages = [...sanitized, ...newMessages]
    // Forced toolChoice applies to round 0 only — by round 1 the tool has already run and
    // the model is narrating/using its result, which must remain free choice.
    const isForcedRound = round === 0 && !!forceToolName
    const gen = provider.streamTurn({
      modelId,
      systemPrompt,
      messages: builtMessages,
      tools,
      settings,
      cacheBoundaryIndex,
      abortSignal,
      forceToolName: isForcedRound ? forceToolName : undefined,
    })
    let result: TurnResult | undefined

    // Drain the generator, forwarding UI chunks to caller
    while (true) {
      const { value, done } = await gen.next()
      if (done) {
        result = value as TurnResult
        break
      }
      const chunk = value as StreamChunk
      // Forward all UI chunks except 'usage' (we re-emit usage below, after the
      // adapter's TurnResult is available, so ordering relative to 'turn' is guaranteed)
      if (chunk.type !== 'usage') {
        yield chunk
      }
    }

    if (!result) break

    // Yield usage first (so sendMessage.ts can read lastUsage before processing turn)
    if (result.usage) yield { type: 'usage', usage: result.usage }
    // Yield the verbatim assistant turn for persistence — neutral format at rest.
    yield { type: 'turn', role: 'assistant', content: result.content, turnIndex }
    turnIndex++

    if (result.stopReason !== 'tool_use' || result.toolUses.length === 0) {
      yield { type: 'stop', stopReason: result.stopReason }
      return
    }

    // Carry the richer replay form (if the adapter provided one) into this
    // invocation's next round only — never persisted verbatim.
    newMessages.push({ role: 'assistant', content: result.replayContent ?? result.content })

    if (abortSignal?.aborted) return

    // Execute tools, apply cap helper, build tool-result message
    // A round can fan out many parallel tool calls (e.g. the model batching N
    // web_search calls); their results all land in the same DynamoDB turn item, so the
    // per-call cap must shrink as the round grows to keep the aggregate bounded.
    const perCallCap = Math.min(TOOL_RESULT_CAP, Math.floor(TOOL_RESULTS_ROUND_CAP / Math.max(1, result.toolUses.length)))
    // Captured into a local so the closures below (which TS can't narrow through, since
    // `result` is a mutable outer `let`) get a definitely-not-undefined array.
    const toolUses = result.toolUses
    // Two representations of the same round's tool results: `toolResultsLive` carries inline
    // image bytes (replayed to the provider in the *next* round of this same invocation —
    // nothing re-hydrates `newMessages` mid-loop), `toolResultsPersist` carries S3 locations
    // instead (small, durable — matches how user attachments are stored at rest). Text-only
    // tool results are identical in both and unaffected by this split.
    // See docs/adr/0005-dual-tool-result-representation.md.
    // Pre-sized (not pushed) so results land back in `toolUses` order even though
    // execution below runs concurrently and can finish in any order — see docs/adr/0016-
    // parallel-tool-execution.md.
    const toolResultsLive: Block[] = new Array(toolUses.length)
    const toolResultsPersist: Block[] = new Array(toolUses.length)

    type ToolOutcome = {
      toolResultChunk: Extract<StreamChunk, { type: 'tool_result' }>
      memoryChunk?: Extract<StreamChunk, { type: 'memoryChanged' }>
      live: Block
      persist: Block
    }

    async function runOneTool(tu: (typeof toolUses)[number]): Promise<ToolOutcome> {
      const input = (() => { try { return JSON.parse(tu.inputJson) } catch { return {} } })()
      const toolResult = await executeTool(tu.name, input, ctx ?? { sub: '' })
      const entries = toolResult.entries
      const textEntries = entries.filter((e): e is Extract<typeof entries[number], { kind: 'text' }> => e.kind === 'text')
      const imageEntries = entries.filter((e): e is Extract<typeof entries[number], { kind: 'image' }> => e.kind === 'image')
      const isError = toolResult.isError

      // Emit memoryChanged when manage_memory / manage_project_memory succeeds (triggers WS
      // memoryUpdated event) — see docs/adr/0013-memory-update-detail-and-editing.md.
      const memoryChunk: ToolOutcome['memoryChunk'] = (tu.name === 'manage_memory' || tu.name === 'manage_project_memory') && !isError
        ? { type: 'memoryChanged', scope: tu.name === 'manage_project_memory' ? 'project' : 'user', operation: String(input?.operation ?? ''), category: input?.category, text: input?.text }
        : undefined

      if (imageEntries.length === 0) {
        // Text-only tool result. Single-call tools (web_search, manage_memory, etc.) return
        // exactly one text entry, but multi-step browser tools with no screenshot (e.g.
        // get_rendered_page's navigate+snapshot, or browse_web with text-only steps) return
        // one entry per step — join them all, not just the first, or later steps' content
        // (e.g. the actual snapshot YAML) silently disappears.
        const rawContent = textEntries.map(t => t.text).join('\n\n')
        const cappedContent = capToolResultText(rawContent, perCallCap)
        const block: Block = { kind: 'tool_result', callId: tu.callId, entries: [{ kind: 'text', text: cappedContent }], isError }
        return {
          toolResultChunk: { type: 'tool_result', toolUseId: tu.callId, name: tu.name, content: cappedContent, isError },
          memoryChunk,
          live: block,
          persist: block,
        }
      }

      // Image-bearing result (e.g. browser screenshots): upload each image to S3 under the
      // same prefix attachments already use (so chat delete/fork already covers them for
      // free), build live (bytes) + persist (s3Uri) entry arrays, and eagerly sign the
      // uploaded screenshots so the live WS frame can render them with no reload needed.
      // `screenshotUrls` travels as its own StreamChunk field (not embedded in `content`) so
      // the client never has to re-parse a JSON envelope out of a text string.
      const liveEntries: NeutralToolResultEntry[] = []
      const persistEntries: NeutralToolResultEntry[] = []
      const screenshotUrls: string[] = []
      const joinedText = textEntries.map(t => t.text).join('\n\n')
      const cappedText = capToolResultText(joinedText, perCallCap)
      if (cappedText) {
        liveEntries.push({ kind: 'text', text: cappedText })
        persistEntries.push({ kind: 'text', text: cappedText })
      }
      for (let i = 0; i < imageEntries.length; i++) {
        const format = imageEntries[i].format
        const bytes = imageEntries[i].bytes
        if (!bytes) continue
        liveEntries.push({ kind: 'image', image: { format, source: { bytes } } })
        if (ctx?.sub && ctx?.chatId) {
          const key = `${s3KeyPrefix(ctx.sub, ctx.chatId)}${tu.name}-${tu.callId}-${i}.${format}`
          const uri = await putObjectBytes(key, bytes, `image/${format}`)
          persistEntries.push({ kind: 'image', image: { format, source: { s3Uri: uri } } })
          screenshotUrls.push(await signCloudFrontUrl(key))
        } else {
          // No durable chat context (e.g. a unit test ctx) — keep bytes in the persisted form
          // too rather than silently dropping the image.
          persistEntries.push({ kind: 'image', image: { format, source: { bytes } } })
        }
      }

      return {
        toolResultChunk: { type: 'tool_result', toolUseId: tu.callId, name: tu.name, content: cappedText, isError, screenshotUrls },
        memoryChunk,
        live: { kind: 'tool_result', callId: tu.callId, entries: liveEntries, isError },
        persist: { kind: 'tool_result', callId: tu.callId, entries: persistEntries, isError },
      }
    }

    // Run this round's tool calls concurrently instead of one-at-a-time — a round batching
    // N web_search/web_fetch calls used to pay their full latency N times over. Capped at
    // TOOL_CONCURRENCY in flight at once (a pool, not a single Promise.all) to avoid
    // hammering rate-limited backends (Jina) or opening too many AgentCore browser sessions
    // at once. See docs/adr/0016-parallel-tool-execution.md.
    let nextToolIndex = 0
    const runningTools = new Map<Promise<ToolOutcome>, number>()
    function launchNextTool() {
      if (nextToolIndex >= toolUses.length) return
      const index = nextToolIndex++
      runningTools.set(runOneTool(toolUses[index]), index)
    }
    for (let i = 0; i < Math.min(TOOL_CONCURRENCY, toolUses.length); i++) launchNextTool()

    while (runningTools.size > 0) {
      const timerId = { current: undefined as ReturnType<typeof setTimeout> | undefined }
      const settled = Promise.race(
        [...runningTools.keys()].map(p => p.then(outcome => ({ done: true as const, p, outcome })))
      )
      const heartbeat = new Promise<{ done: false }>(resolve => { timerId.current = setTimeout(() => resolve({ done: false }), HEARTBEAT_INTERVAL_MS) })
      const outcome = await Promise.race([settled, heartbeat])
      clearTimeout(timerId.current)
      if (!outcome.done) {
        yield { type: 'heartbeat' }
        continue
      }
      const index = runningTools.get(outcome.p)!
      runningTools.delete(outcome.p)
      launchNextTool()
      toolResultsLive[index] = outcome.outcome.live
      toolResultsPersist[index] = outcome.outcome.persist
      yield outcome.outcome.toolResultChunk
      if (outcome.outcome.memoryChunk) yield outcome.outcome.memoryChunk
    }

    // Yield the user tool-result turn for persistence (s3Uri form, neutral at rest)
    yield { type: 'turn', role: 'user', content: toolResultsPersist, turnIndex }
    turnIndex++

    // Budget pacing: the model otherwise has no idea how much room it has left and
    // researches at full tilt until cut off. Steer it via the live-only replay —
    // never toolResultsPersist, so this never becomes stored conversation content.
    // See docs/adr/0020-research-depth-and-budget-pacing.md.
    const roundsRemaining = maxRounds - round - 1
    const pacingThreshold = Math.max(1, Math.ceil(maxRounds / 3))
    if (roundsRemaining <= pacingThreshold) {
      const pacingText = roundsRemaining <= 0
        ? "This is your last tool round. After these results you must write your final answer."
        : `Research budget: ${roundsRemaining} of ${maxRounds} tool rounds remain. Assess whether you have enough to answer. If yes, write your final answer now. If a critical gap remains, spend the remaining rounds only on that gap.`
      toolResultsLive.push({ kind: 'text', text: pacingText })
    }

    // Continue the loop with the bytes-inline form (this invocation's next round only)
    newMessages.push({ role: 'user', content: toolResultsLive })
    // Loop → next turn with tool results injected
  }

  if (abortSignal?.aborted) return

  // Exhausted tool-use rounds: make one final call. We keep tools present
  // (history contains tool_call/tool_result blocks and the provider may require it)
  // but the loop is already done after this single call regardless of stopReason,
  // so no infinite-tool-use risk.
  const builtMessages = [...sanitized, ...newMessages]
  const finalGen = provider.streamTurn({
    modelId,
    systemPrompt,
    messages: builtMessages,
    tools,
    settings,
    cacheBoundaryIndex,
    abortSignal,
  })
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
    // with a tool_call block gets held as "pending" by sendMessage.ts until it's paired
    // with a tool-result turn — which will never come — so it's silently dropped when
    // 'stop' fires right after, ending the chat with no visible or persisted answer.
    // Strip any tool_call blocks and guarantee there's always visible text to persist.
    const finalContent = finalResult.content.filter(b => b.kind !== 'tool_call')
    const hasText = finalContent.some(b => b.kind === 'text' && b.text)
    if (!hasText) {
      finalContent.push({ kind: 'text', text: "I've reached my research step limit for this turn. Here's what I found before stopping — let me know if you'd like me to continue." })
    }
    yield { type: 'turn', role: 'assistant', content: finalContent, turnIndex, truncated: true }
    yield { type: 'stop', stopReason: finalResult.stopReason === 'tool_use' ? 'max_rounds' : finalResult.stopReason }
  } else {
    yield { type: 'stop', stopReason: 'max_rounds' }
  }
}

// ── One-shot non-streaming call (used for title generation) ──────────────────

export async function converseOnce(
  modelId: string,
  systemPrompt: string,
  messages: NeutralMessage[],
  options?: { maxTokens?: number },
): Promise<string> {
  const provider = getProvider(modelId)
  return provider.once({ modelId, systemPrompt, messages, maxTokens: options?.maxTokens })
}
