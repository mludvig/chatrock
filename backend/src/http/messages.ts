import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { getChat, listMessages } from '../lib/dynamo'
import { subFromClaims } from '../lib/auth'
import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime'
import type { TokenUsage } from '../lib/bedrock'

const CORS = { 'Access-Control-Allow-Origin': '*' }

const ok = (body: unknown): APIGatewayProxyResultV2 => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(body),
})

const err = (status: number, msg: string): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify({ message: msg }),
})

// ── Display types (safe to send to client — no signatures / redactedContent) ──

interface ThinkingStep {
  kind: 'thinking'
  text: string
}
interface TextStep {
  kind: 'text'
  text: string
}
interface ToolStep {
  kind: 'tool'
  toolUseId: string
  name: string
  input: string
  result?: string
  isError?: boolean
}

type Step = ThinkingStep | TextStep | ToolStep

interface DisplayBubble {
  role: 'user' | 'assistant'
  steps: Step[]
  model: string
  createdAt: string
  usage?: TokenUsage
}

interface ConversationResponse {
  bubbles: DisplayBubble[]
  conversationUsage: TokenUsage
}

// ── Turn record shape (format C from DynamoDB) ────────────────────────────────

interface TurnRow {
  PK: string
  SK: string
  role: 'user' | 'assistant'
  blocks: ContentBlock[]
  model: string
  createdAt: string
  turnIndex: number
  responseId: string
  usage?: TokenUsage
}

// ── groupTurnsToBubbles ───────────────────────────────────────────────────────

/**
 * Convert format-C per-turn DDB rows into display bubbles:
 *
 * - Each plain user row (no toolResult blocks) → its own user bubble.
 * - Consecutive assistant turns + their interleaved user-toolResult turns
 *   sharing the same responseId → ONE assistant bubble with ordered steps.
 * - toolResult-user rows are folded into the assistant bubble (not their
 *   own bubble), so the assistant bubble shows tool calls with their results.
 *
 * Raw blocks, signatures, and redactedContent are never included in output.
 */
function groupTurnsToBubbles(rows: TurnRow[]): ConversationResponse {
  const bubbles: DisplayBubble[] = []
  const conversationUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

  // Accumulate a tool-step map for the current assistant bubble
  // keyed by toolUseId so toolResult rows can fold their results in
  let currentBubble: DisplayBubble | null = null
  let currentToolSteps: Map<string, ToolStep> | null = null
  let currentResponseId: string | null = null

  function flushAssistantBubble() {
    if (currentBubble) {
      bubbles.push(currentBubble)
      currentBubble = null
      currentToolSteps = null
      currentResponseId = null
    }
  }

  for (const row of rows) {
    // Check if this user row is a toolResult row (belongs to an assistant group)
    const isToolResultRow =
      row.role === 'user' &&
      row.blocks.length > 0 &&
      row.blocks.every(b => 'toolResult' in b)

    if (row.role === 'assistant') {
      // Start or continue an assistant bubble
      if (currentResponseId !== row.responseId) {
        flushAssistantBubble()
        currentBubble = {
          role: 'assistant',
          steps: [],
          model: row.model,
          createdAt: row.createdAt,
        }
        currentToolSteps = new Map()
        currentResponseId = row.responseId
      }

      // Map blocks → ordered steps (never expose signature/redactedContent)
      for (const block of row.blocks) {
        if ('reasoningContent' in block && block.reasoningContent) {
          const rc = block.reasoningContent
          const text = 'reasoningText' in rc && rc.reasoningText ? (rc.reasoningText.text ?? '') : ''
          currentBubble!.steps.push({ kind: 'thinking', text })
        } else if ('text' in block && block.text !== undefined) {
          currentBubble!.steps.push({ kind: 'text', text: block.text })
        } else if ('toolUse' in block && block.toolUse) {
          const tu = block.toolUse
          const step: ToolStep = {
            kind: 'tool',
            toolUseId: tu.toolUseId ?? '',
            name: tu.name ?? '',
            input: JSON.stringify(tu.input ?? {}),
          }
          currentBubble!.steps.push(step)
          currentToolSteps!.set(step.toolUseId, step)
        }
        // cachePoint and unknown blocks are silently skipped
      }

      // Accumulate usage into bubble and conversation total
      if (row.usage) {
        const u = row.usage
        const prev = currentBubble!.usage ?? { inputTokens: 0, outputTokens: 0 }
        currentBubble!.usage = {
          inputTokens: prev.inputTokens + (u.inputTokens ?? 0),
          outputTokens: prev.outputTokens + (u.outputTokens ?? 0),
          ...(u.cacheReadInputTokens !== undefined || prev.cacheReadInputTokens !== undefined
            ? { cacheReadInputTokens: (prev.cacheReadInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) }
            : {}),
          ...(u.cacheWriteInputTokens !== undefined || prev.cacheWriteInputTokens !== undefined
            ? { cacheWriteInputTokens: (prev.cacheWriteInputTokens ?? 0) + (u.cacheWriteInputTokens ?? 0) }
            : {}),
        }
        conversationUsage.inputTokens += u.inputTokens ?? 0
        conversationUsage.outputTokens += u.outputTokens ?? 0
        if (u.cacheReadInputTokens) {
          conversationUsage.cacheReadInputTokens = (conversationUsage.cacheReadInputTokens ?? 0) + u.cacheReadInputTokens
        }
        if (u.cacheWriteInputTokens) {
          conversationUsage.cacheWriteInputTokens = (conversationUsage.cacheWriteInputTokens ?? 0) + u.cacheWriteInputTokens
        }
      }

    } else if (isToolResultRow && currentBubble && currentToolSteps) {
      // Fold tool results into the current assistant bubble's matching tool steps
      for (const block of row.blocks) {
        if (!('toolResult' in block) || !block.toolResult) continue
        const tr = block.toolResult
        const step = currentToolSteps.get(tr.toolUseId ?? '')
        if (step) {
          const rawResult = tr.content?.[0] && 'text' in tr.content[0]
            ? (tr.content[0].text ?? '')
            : ''
          step.result = rawResult
          step.isError = tr.status === 'error'
        }
      }
    } else {
      // Plain user turn (not a toolResult row)
      flushAssistantBubble()
      const steps: Step[] = []
      for (const block of row.blocks) {
        if ('text' in block && block.text !== undefined) {
          steps.push({ kind: 'text', text: block.text })
        }
      }
      bubbles.push({
        role: 'user',
        steps,
        model: row.model,
        createdAt: row.createdAt,
      })
    }
  }

  flushAssistantBubble()

  return { bubbles, conversationUsage }
}

// ── Lambda handler ────────────────────────────────────────────────────────────

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const sub = subFromClaims(event.requestContext.authorizer.jwt.claims)
  const chatId = event.pathParameters?.chatId
  if (!chatId) return err(400, 'Missing chatId')

  const chat = await getChat(sub, chatId)
  if (!chat) return err(404, 'Not found')

  const items = await listMessages(chatId)
  const rows = items as unknown as TurnRow[]
  const response = groupTurnsToBubbles(rows)
  return ok(response)
}
