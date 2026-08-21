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
import { getCapabilities, type ModelSettings } from '../../../config/models'
import { ensureBedrockAuth, bedrockRegion } from '../../bedrockAuth'
import type { StreamChunk, TurnResult, TurnRequest, OnceRequest, ChatProvider, TokenUsage } from '../types'
import type { ToolSpec } from '../toolSpec'
import type { NeutralMessage } from '../blocks'
import { toNeutral, fromNeutralMessage, toNeutralMessage } from './converseTranslate'
import { coalesceMessages, healDanglingToolUse, historyHasToolBlocks } from '../sanitize'
import { buildDefaultToolList } from '../toolGating'

export const bedrockClient = new BedrockRuntimeClient({
  region: bedrockRegion(),
})

function buildInferenceParams(modelId: string, settings: ModelSettings) {
  const caps = getCapabilities(modelId)
  const thinkingActive = caps.thinking !== 'none' && settings.thinkingEffort && settings.thinkingEffort !== 'off'

  // Temperature and topP must be omitted when thinking is active (API requirement)
  const inferenceConfig: Record<string, unknown> = { maxTokens: caps.maxOutputTokens ?? 16000 }
  if (!thinkingActive) {
    if (caps.temperature && settings.temperature !== undefined) inferenceConfig.temperature = settings.temperature
    if (caps.topP && settings.topP !== undefined) inferenceConfig.topP = settings.topP
  }

  const additionalFields: DocumentType = {}
  if (caps.topK && settings.topK !== undefined) (additionalFields as Record<string, DocumentType>).top_k = settings.topK
  if (thinkingActive && caps.thinking === 'adaptive') {
    // display defaults to 'omitted' on the 5-series models (Opus 5/Sonnet 5/etc) —
    // request 'summarized' explicitly or thinking blocks come back text-empty (signature only).
    (additionalFields as Record<string, DocumentType>).thinking = { type: 'adaptive', display: 'summarized' } as DocumentType
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

function toBedrockTool(spec: ToolSpec): Tool {
  return { toolSpec: { name: spec.name, description: spec.description, inputSchema: { json: spec.inputSchema as DocumentType } } }
}

/** Trailing cachePoint so the tool definitions (stable across all turns) get cached
 *  on first use. Empty input -> empty output (no dangling cachePoint-only list).
 *  `cachingEnabled` gates the cachePoint itself — a model with promptCaching:'none'
 *  (e.g. Grok 4.6) gets an AccessDeniedException if a cachePoint is sent at all. */
function toBedrockToolsWithCache(tools: ToolSpec[], cachingEnabled: boolean): Tool[] {
  if (tools.length === 0) return []
  return cachingEnabled ? [...tools.map(toBedrockTool), CACHE_POINT_TOOL] : tools.map(toBedrockTool)
}

// Converse-specific requirement: it rejects tool blocks in history without a non-empty
// toolConfig. When the caller has no organic tools to offer but the replayed history
// contains tool_call/tool_result blocks, this re-offers a minimal default set so
// toolConfig is present and valid. (Not needed for a provider without that constraint.)
function buildDefaultToolSet(cachingEnabled: boolean): Tool[] {
  return toBedrockToolsWithCache(buildDefaultToolList(), cachingEnabled)
}

/**
 * Build the system prompt array, with a trailing cachePoint when `cachingEnabled`.
 * Returns undefined when systemPrompt is empty (no dangling cachePoint).
 * See docs/adr/0019-prompt-cache-breakpoint-placement.md — one marker for the
 * whole prompt, so memory/manifest churn invalidates the entire block.
 */
function buildSystemWithCache(systemPrompt: string, cachingEnabled: boolean): SystemContentBlock[] | undefined {
  if (!systemPrompt) return undefined
  const text = { text: systemPrompt } as SystemContentBlock
  return cachingEnabled ? [text, CACHE_POINT_SYSTEM] : [text]
}

/**
 * Return a copy of `messages` with a cachePoint injected after the last block of
 * the message at `boundaryIndex` — the ONE cache marker for this request, placed
 * at the end of the "stable prior" prefix so it replaces (not accumulates) as the
 * conversation grows. boundaryIndex < 0 (nothing stable yet) or `!cachingEnabled`
 * is a no-op.
 */
function injectCachePointAt(messages: Message[], boundaryIndex: number, cachingEnabled: boolean): Message[] {
  if (!cachingEnabled || boundaryIndex < 0 || boundaryIndex >= messages.length) return messages
  return messages.map((m, i) => i === boundaryIndex ? { ...m, content: [...(m.content ?? []), CACHE_POINT_CONTENT] } : m)
}

// Raw, Bedrock-content-shaped result of one streamed Converse call — distinct from
// the neutral TurnResult (llm/types.ts) that streamTurn() converts it into below.
interface RawTurnResult {
  stopReason: string
  textContent: string
  toolUses: Array<{ toolUseId: string; name: string; inputJson: string }>
  content: ContentBlock[]
  usage?: TokenUsage
}

async function* streamOneTurn(
  modelId: string,
  systemPrompt: string,
  messages: Message[],
  tools: Tool[],
  settings: ModelSettings,
  cachingEnabled: boolean,
  abortSignal?: AbortSignal,
  forceToolName?: string,
): AsyncGenerator<StreamChunk, RawTurnResult> {
  // Only attach toolConfig when there is at least one real toolSpec — a list
  // containing only CACHE_POINT_TOOL (no toolSpec) is treated as empty.
  const hasRealTools = tools.some(t => 'toolSpec' in (t as object))
  const cmd = new ConverseStreamCommand({
    modelId,
    system: buildSystemWithCache(systemPrompt, cachingEnabled),
    messages,
    ...buildInferenceParams(modelId, settings),
    ...(hasRealTools
      ? { toolConfig: { tools, ...(forceToolName ? { toolChoice: { tool: { name: forceToolName } } } : {}) } }
      : {}),
  })

  await ensureBedrockAuth()
  const res = await bedrockClient.send(cmd, ...(abortSignal ? [{ abortSignal }] : []))
  if (!res.stream) throw new Error('No stream in Bedrock response')

  let stopReason = 'end_turn'
  let textContent = ''
  let usage: RawTurnResult['usage']

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

// ── One-shot non-streaming call (used for title generation) ──────────────────

export async function converseOnce(
  modelId: string,
  systemPrompt: string,
  messages: Message[],
  options?: { maxTokens?: number },
): Promise<string> {
  const caps = getCapabilities(modelId)
  // This is a one-shot deterministic-output helper (title/summary/JSON extraction) —
  // never reasoning. On the 5-series models, Bedrock auto-emits a reasoningContent
  // block even when `thinking` is never requested, which both eats the maxTokens
  // budget and shifts the real text block off index 0 — explicitly disable it.
  const additionalModelRequestFields = caps.thinking !== 'none' ? { thinking: { type: 'disabled' } } : undefined
  const cmd = new ConverseCommand({
    modelId,
    system: systemPrompt ? [{ text: systemPrompt }] : undefined,
    messages,
    inferenceConfig: { maxTokens: options?.maxTokens ?? 64 },
    additionalModelRequestFields,
  })
  await ensureBedrockAuth()
  const res = await bedrockClient.send(cmd)
  const block = res.output?.message?.content?.find(b => 'text' in b)
  if (block && 'text' in block) return (block.text ?? '').trim()
  return ''
}

// ── ChatProvider implementation ────────────────────────────────────────────────

// Drop any ThinkingBlock whose opaque isn't ours (or is missing) — a foreign or
// absent signature is a hard Converse ValidationException — then drop any message
// left with zero blocks as a result, before the Bedrock-shape repair passes run.
function stripForeignThinking(messages: NeutralMessage[]): NeutralMessage[] {
  return messages
    .map(m => ({ ...m, content: m.content.filter(b => b.kind !== 'thinking' || b.opaque?.provider === 'bedrock-converse') }))
    .filter(m => m.content.length > 0)
}

function sanitizeHistory(messages: NeutralMessage[]): NeutralMessage[] {
  const filtered = stripForeignThinking(messages)
  const bedrockMessages = filtered.map(fromNeutralMessage)
  const healed = healDanglingToolUse(coalesceMessages(bedrockMessages))
  return healed.map(m => toNeutralMessage(m as { role: 'user' | 'assistant'; content?: ContentBlock[] }))
}

async function* streamTurn(req: TurnRequest): AsyncGenerator<StreamChunk, TurnResult> {
  const cachingEnabled = getCapabilities(req.modelId).promptCaching !== 'none'
  const bedrockMessages = req.messages.map(fromNeutralMessage)
  const withCache = injectCachePointAt(bedrockMessages, req.cacheBoundaryIndex, cachingEnabled)

  let tools = toBedrockToolsWithCache(req.tools, cachingEnabled)
  if (tools.length === 0 && historyHasToolBlocks(bedrockMessages)) {
    tools = buildDefaultToolSet(cachingEnabled)
  }

  // Bedrock rejects toolChoice together with adaptive thinking — a forced round
  // always runs with thinking off (a tool-choice round needs none anyway).
  const roundSettings = req.forceToolName ? { ...req.settings, thinkingEffort: 'off' as const } : req.settings

  const gen = streamOneTurn(req.modelId, req.systemPrompt, withCache, tools, roundSettings, cachingEnabled, req.abortSignal, req.forceToolName)
  let raw: RawTurnResult | undefined
  while (true) {
    const { value, done } = await gen.next()
    if (done) { raw = value; break }
    yield value
  }
  if (!raw) throw new Error('bedrockConverse.streamTurn: no result from streamOneTurn')

  return {
    stopReason: raw.stopReason,
    textContent: raw.textContent,
    toolUses: raw.toolUses.map(tu => ({ callId: tu.toolUseId, name: tu.name, inputJson: tu.inputJson })),
    content: toNeutral(raw.content),
    usage: raw.usage,
  }
}

async function once(req: OnceRequest): Promise<string> {
  return converseOnce(req.modelId, req.systemPrompt, req.messages.map(fromNeutralMessage), { maxTokens: req.maxTokens })
}

export const bedrockConverseProvider: ChatProvider = {
  id: 'bedrock-converse',
  sanitizeHistory,
  streamTurn,
  once,
}
