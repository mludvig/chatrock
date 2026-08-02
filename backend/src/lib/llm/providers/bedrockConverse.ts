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
import { WEB_TOOLS, MEMORY_TOOL, MANAGE_PROJECT_MEMORY_TOOL, READ_PROJECT_FILE_TOOL, READ_PROJECT_CHAT_TOOL, BROWSER_TOOL, TAKE_SCREENSHOT_TOOL, GET_RENDERED_PAGE_TOOL, SEARCH_HISTORY_TOOL, GENERATE_IMAGE_TOOL, type ToolContext } from '../../tools'
import type { ToolSpec } from '../toolSpec'
import { getCapabilities, type ModelSettings } from '../../../config/models'
import { ensureBedrockAuth, bedrockRegion } from '../../bedrockAuth'
import type { StreamChunk, TurnResult } from '../types'

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

function toBedrockTool(spec: ToolSpec): Tool {
  return { toolSpec: { name: spec.name, description: spec.description, inputSchema: { json: spec.inputSchema as DocumentType } } }
}

// Converse-specific requirement: it rejects tool blocks in history without a non-empty
// toolConfig. When the loop has no organic tools to offer but the replayed history
// contains tool_use/tool_result blocks, this re-offers a minimal default set so
// toolConfig is present and valid. (Not needed for a provider without that constraint.)
export function buildDefaultToolSet(): Tool[] {
  return [...WEB_TOOLS, MEMORY_TOOL].map(toBedrockTool)
}

/**
 * Build the tools list with a trailing cachePoint so the tool definitions
 * (which are stable across all turns) get cached on first use.
 * Gate web tools and memory tool independently.
 */
export function buildToolsWithCache(settings: ModelSettings, ctx?: ToolContext): Tool[] {
  const list: ToolSpec[] = []
  if (settings.webSearchEnabled !== false) list.push(...WEB_TOOLS)
  if (settings.browserCoreEnabled !== false) list.push(TAKE_SCREENSHOT_TOOL, GET_RENDERED_PAGE_TOOL)
  if (settings.browserExtendedEnabled === true) list.push(BROWSER_TOOL)
  if (settings.memoryEnabled !== false) list.push(MEMORY_TOOL)
  if (ctx?.projectId && settings.memoryEnabled !== false) list.push(MANAGE_PROJECT_MEMORY_TOOL)
  if (ctx?.projectId) list.push(READ_PROJECT_FILE_TOOL, READ_PROJECT_CHAT_TOOL)
  // ctx.searchScope is set only for a forced/explicit Search turn (ws/sendMessage.ts) — force
  // the tool into the list even if searchEnabled:false, since Bedrock's toolChoice requires the
  // named tool to be present in `tools`.
  if (settings.searchEnabled !== false || ctx?.searchScope) list.push(SEARCH_HISTORY_TOOL)
  if (settings.imageGenerationEnabled === true) list.push(GENERATE_IMAGE_TOOL)
  if (list.length === 0) return []
  return [...list.map(toBedrockTool), CACHE_POINT_TOOL]
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
export function buildMessagesWithCache(baseMessages: Message[], newMessages: Message[]): Message[] {
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

export async function* streamOneTurn(
  modelId: string,
  systemPrompt: string,
  messages: Message[],
  tools: Tool[],
  settings: ModelSettings,
  abortSignal?: AbortSignal,
  forceToolName?: string,
): AsyncGenerator<StreamChunk, TurnResult> {
  // Only attach toolConfig when there is at least one real toolSpec — a list
  // containing only CACHE_POINT_TOOL (no toolSpec) is treated as empty.
  const hasRealTools = tools.some(t => 'toolSpec' in (t as object))
  const cmd = new ConverseStreamCommand({
    modelId,
    system: buildSystemWithCache(systemPrompt),
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
  let usage: TurnResult['usage']

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
  const cmd = new ConverseCommand({
    modelId,
    system: systemPrompt ? [{ text: systemPrompt }] : undefined,
    messages,
    inferenceConfig: { maxTokens: options?.maxTokens ?? 64 },
  })
  await ensureBedrockAuth()
  const res = await bedrockClient.send(cmd)
  const block = res.output?.message?.content?.[0]
  if (block && 'text' in block) return (block.text ?? '').trim()
  return ''
}
