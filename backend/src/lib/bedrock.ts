import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  ConverseCommand,
  type Message,
  type Tool,
  type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime'
import type { DocumentType } from '@smithy/types'
import { executeTool, WEB_TOOLS } from './tools'
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

// ── Internal streaming for one Bedrock turn ──────────────────────────────────

interface TurnResult {
  stopReason: string
  textContent: string
  toolUses: Array<{ toolUseId: string; name: string; inputJson: string }>
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

async function* streamOneTurn(
  modelId: string,
  systemPrompt: string,
  messages: Message[],
  tools: Tool[],
  settings: ModelSettings,
): AsyncGenerator<StreamChunk, TurnResult> {
  const cmd = new ConverseStreamCommand({
    modelId,
    system: systemPrompt ? [{ text: systemPrompt }] : undefined,
    messages,
    ...buildInferenceParams(modelId, settings),
    ...(tools.length > 0 ? { toolConfig: { tools } } : {}),
  })

  const res = await bedrockClient.send(cmd)
  if (!res.stream) throw new Error('No stream in Bedrock response')

  let stopReason = 'end_turn'
  let textContent = ''
  // Accumulate per-block state
  const blockType: Record<number, 'text' | 'thinking' | 'toolUse'> = {}
  const toolUseAcc: Record<number, { toolUseId: string; name: string; inputJson: string }> = {}
  const toolUses: Array<{ toolUseId: string; name: string; inputJson: string }> = []

  for await (const event of res.stream) {
    // Block start — record what type this block index is
    if (event.contentBlockStart) {
      const idx = event.contentBlockStart.contentBlockIndex ?? 0
      const start = event.contentBlockStart.start
      if (start?.toolUse) {
        blockType[idx] = 'toolUse'
        toolUseAcc[idx] = { toolUseId: start.toolUse.toolUseId ?? '', name: start.toolUse.name ?? '', inputJson: '' }
        yield { type: 'tool_call_start', toolUseId: start.toolUse.toolUseId ?? '', name: start.toolUse.name ?? '' }
      } else {
        blockType[idx] = 'text'
      }
    }

    // Block delta
    if (event.contentBlockDelta) {
      const idx = event.contentBlockDelta.contentBlockIndex ?? 0
      const delta = event.contentBlockDelta.delta

      if (delta?.text) {
        if (blockType[idx] === 'thinking') {
          yield { type: 'thinking_delta', text: delta.text }
        } else {
          textContent += delta.text
          yield { type: 'delta', text: delta.text }
        }
      } else if (delta?.reasoningContent?.text) {
        // First delta on a reasoning block
        if (blockType[idx] !== 'thinking') {
          blockType[idx] = 'thinking'
        }
        yield { type: 'thinking_delta', text: delta.reasoningContent.text }
      } else if (delta?.toolUse?.input) {
        if (toolUseAcc[idx]) toolUseAcc[idx].inputJson += delta.toolUse.input
      }
    }

    // Block stop
    if (event.contentBlockStop) {
      const idx = event.contentBlockStop.contentBlockIndex ?? 0
      if (blockType[idx] === 'thinking') {
        yield { type: 'thinking_done' }
      }
      if (blockType[idx] === 'toolUse' && toolUseAcc[idx]) {
        const tu = toolUseAcc[idx]
        toolUses.push(tu)
        yield { type: 'tool_call', toolUseId: tu.toolUseId, name: tu.name, input: tu.inputJson }
      }
    }

    // Message stop
    if (event.messageStop) {
      stopReason = event.messageStop.stopReason ?? 'end_turn'
    }
  }

  return { stopReason, textContent, toolUses }
}

// ── Public: full agentic streaming loop with tool use ────────────────────────

export async function* converseStream(
  modelId: string,
  systemPrompt: string,
  messages: Message[],
  settings: ModelSettings = {},
): AsyncGenerator<StreamChunk> {
  const tools = WEB_TOOLS
  const conversation: Message[] = [...messages]

  // Safety cap: max 5 tool-use rounds before forcing a final answer
  for (let round = 0; round < 5; round++) {
    const gen = streamOneTurn(modelId, systemPrompt, conversation, tools, settings)
    let result: TurnResult | undefined

    // Drain the generator, forwarding chunks to caller
    while (true) {
      const { value, done } = await gen.next()
      if (done) {
        result = value as TurnResult
        break
      }
      yield value as StreamChunk
    }

    if (!result) break

    if (result.stopReason !== 'tool_use' || result.toolUses.length === 0) {
      yield { type: 'stop', stopReason: result.stopReason }
      return
    }

    // Build the assistant content block for this turn (text + tool use blocks)
    const assistantContent: ContentBlock[] = []
    if (result.textContent) assistantContent.push({ text: result.textContent })
    for (const tu of result.toolUses) {
      assistantContent.push({
        toolUse: {
          toolUseId: tu.toolUseId,
          name: tu.name,
          input: (() => { try { return JSON.parse(tu.inputJson) } catch { return {} } })(),
        },
      })
    }
    conversation.push({ role: 'assistant', content: assistantContent })

    // Execute tools and build tool result message
    const toolResults: ContentBlock[] = []
    for (const tu of result.toolUses) {
      const input = (() => { try { return JSON.parse(tu.inputJson) } catch { return {} } })()
      const toolResult = await executeTool(tu.name, input)
      const resultContent = toolResult.content?.[0] && 'text' in toolResult.content[0]
        ? (toolResult.content[0].text ?? '')
        : ''
      const isError = toolResult.status === 'error'

      yield { type: 'tool_result', toolUseId: tu.toolUseId, name: tu.name, content: resultContent, isError }

      toolResults.push({
        toolResult: {
          toolUseId: tu.toolUseId,
          content: [{ text: resultContent }],
          status: toolResult.status,
        },
      })
    }
    conversation.push({ role: 'user', content: toolResults })
    // Loop → next turn with tool results injected
  }

  // Fell off the loop (too many rounds) — emit a stop
  yield { type: 'stop', stopReason: 'max_rounds' }
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
