import { marked } from 'marked'
import { signCloudFrontUrl } from './attachments'
import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime'
import type { TokenUsage } from './bedrock'

// ── Display types (safe to send to clients / render publicly — no signatures / redactedContent) ──
//
// Moved here from http/messages.ts so the same "raw turn rows → display bubbles" transform can back
// GET /messages (authenticated JSON), the public share renderer (/s/{id}), and Markdown export.
// The transform deliberately never emits thinking `signature` / `redactedContent`.

export interface ThinkingStep {
  kind: 'thinking'
  text: string
}
export interface TextStep {
  kind: 'text'
  text: string
}
export interface ToolStep {
  kind: 'tool'
  toolUseId: string
  name: string
  input: string
  result?: string
  isError?: boolean
  screenshotUrls?: string[]
}
export interface AttachmentStep {
  kind: 'attachment'
  attachmentKind: 'image' | 'document'
  filename: string
  contentType: string
  url: string
  s3Key: string
  mode?: 'standard' | 'rich'
}

export type Step = ThinkingStep | TextStep | ToolStep | AttachmentStep

// Internal shape returned by groupTurnsToBubbles (no sibling metadata yet)
export interface RawBubble {
  msgId: string
  parentId: string | null
  role: 'user' | 'assistant'
  steps: Step[]
  model: string
  createdAt: string
  usage?: TokenUsage
  thinkingEffort?: string
  webSearchEnabled?: boolean
  errored?: boolean
}

export interface RawConversationResponse {
  bubbles: RawBubble[]
  conversationUsage: TokenUsage
}

// ── Turn record shape (format C from DynamoDB) ────────────────────────────────

export interface TurnRow {
  PK: string
  SK: string
  msgId: string
  parentId: string | null
  role: 'user' | 'assistant'
  blocks: ContentBlock[]
  model: string
  createdAt: string
  turnIndex: number
  responseId: string
  usage?: TokenUsage
  thinkingEffort?: string
  webSearchEnabled?: boolean
  incomplete?: boolean
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
export async function groupTurnsToBubbles(rows: TurnRow[]): Promise<RawConversationResponse> {
  const bubbles: RawBubble[] = []
  const conversationUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

  // Accumulate a tool-step map for the current assistant bubble
  // keyed by toolUseId so toolResult rows can fold their results in
  let currentBubble: RawBubble | null = null
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
          msgId: row.msgId,
          parentId: row.parentId,
          role: 'assistant',
          steps: [],
          model: row.model,
          createdAt: row.createdAt,
          ...(row.thinkingEffort !== undefined ? { thinkingEffort: row.thinkingEffort } : {}),
          ...(row.webSearchEnabled !== undefined ? { webSearchEnabled: row.webSearchEnabled } : {}),
        }
        currentToolSteps = new Map()
        currentResponseId = row.responseId
      }

      // If any turn in this response is incomplete (partial error flush), mark bubble errored
      if (row.incomplete && currentBubble) {
        currentBubble.errored = true
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
          const contentBlocks = tr.content ?? []
          const textEntries = contentBlocks.filter(c => 'text' in c) as Array<{ text?: string }>
          const imageEntries = contentBlocks.filter(c => 'image' in c) as Array<{ image?: { source?: { s3Location?: { uri: string } } } }>

          if (imageEntries.length > 0) {
            // Image-bearing tool result (e.g. browser screenshots): screenshotUrls is a
            // first-class field (signed fresh on every load, 1h expiry) — not a JSON envelope
            // smuggled inside `result`, so the client never has to re-parse it.
            const screenshotUrls: string[] = []
            for (const img of imageEntries) {
              const uri = img.image?.source?.s3Location?.uri
              if (!uri) continue
              const key = uri.replace(/^s3:\/\/[^/]+\//, '')
              screenshotUrls.push(await signCloudFrontUrl(key))
            }
            step.result = textEntries.map(t => t.text ?? '').join('\n\n')
            step.screenshotUrls = screenshotUrls
          } else {
            step.result = textEntries[0]?.text ?? ''
          }
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
        } else if ('image' in block && block.image) {
          const src = block.image.source as { s3Location?: { uri: string }; bytes?: unknown }
          if (src?.s3Location) {
            const key = src.s3Location.uri.replace(/^s3:\/\/[^/]+\//, '')
            const filename = key.split('/').pop() || 'image'
            const url = await signCloudFrontUrl(key)
            steps.push({
              kind: 'attachment',
              attachmentKind: 'image',
              filename,
              contentType: `image/${block.image.format ?? 'png'}`,
              url,
              s3Key: key,
            })
          }
          // blocks with bytes are silently skipped (defensive; should not be stored)
        } else if ('document' in block && block.document) {
          const src = block.document.source as { s3Location?: { uri: string }; bytes?: unknown }
          if (src?.s3Location) {
            const key = src.s3Location.uri.replace(/^s3:\/\/[^/]+\//, '')
            const filename = key.split('/').pop() || 'document'
            const url = await signCloudFrontUrl(key)
            const formatToMime: Record<string, string> = {
              pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
            }
            const citations = block.document.citations as { enabled: boolean } | undefined
            steps.push({
              kind: 'attachment',
              attachmentKind: 'document',
              filename: block.document.name ?? filename,
              contentType: formatToMime[block.document.format ?? 'txt'] ?? 'application/octet-stream',
              url,
              s3Key: key,
              ...(citations?.enabled !== undefined
                ? { mode: citations.enabled ? 'rich' as const : 'standard' as const }
                : {}),
            })
          }
        }
      }
      bubbles.push({
        msgId: row.msgId,
        parentId: row.parentId,
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

// ── Include/exclude filtering (thinking / tool calls) ─────────────────────────

export interface IncludeOpts {
  includeThinking: boolean
  includeTools: boolean
}

/**
 * Drop thinking and/or tool steps per the share/export options. `clean` = both false.
 * Applied identically for the public share render and Markdown export so they can never drift.
 */
export function filterSteps(bubbles: RawBubble[], opts: IncludeOpts): RawBubble[] {
  return bubbles.map(b => ({
    ...b,
    steps: b.steps.filter(s => {
      // A redacted/empty thinking block has nothing to show — the live app's ThinkingBlock
      // already suppresses this case, but the share/export renderers didn't, leaving a
      // clickable disclosure that reveals nothing.
      if (s.kind === 'thinking') return opts.includeThinking && s.text.trim().length > 0
      if (s.kind === 'tool') return opts.includeTools
      return true
    }),
  }))
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

function roleHeading(b: RawBubble): string {
  return b.role === 'user' ? '## User' : `## Assistant${b.model ? ` (${b.model})` : ''}`
}

function stepToMarkdown(step: Step): string {
  switch (step.kind) {
    case 'text':
      return step.text.trim()
    case 'thinking':
      // Blockquote keeps thinking visually distinct without breaking downstream parsers.
      return `> **Thinking**\n>\n${step.text.trim().split('\n').map(l => `> ${l}`).join('\n')}`
    case 'tool': {
      const parts: string[] = [`**Tool call: \`${step.name}\`**`]
      let input = step.input
      try { input = JSON.stringify(JSON.parse(step.input), null, 2) } catch { /* leave as-is */ }
      parts.push('Input:', '```json', input, '```')
      if (step.result !== undefined && step.result !== '') {
        parts.push(step.isError ? 'Result (error):' : 'Result:', '```', step.result, '```')
      }
      if (step.screenshotUrls?.length) {
        parts.push(...step.screenshotUrls.map((u, i) => `![screenshot ${i + 1}](${u})`))
      }
      return parts.join('\n')
    }
    case 'attachment':
      return step.attachmentKind === 'image'
        ? `![${step.filename}](${step.url})`
        : `[Attachment: ${step.filename}](${step.url})`
  }
}

export interface RenderMeta {
  title: string
}

/**
 * Serialize display bubbles to Markdown with clear turn separators. Assistant text is already
 * Markdown so it's emitted verbatim. Callers apply filterSteps() beforehand for include/exclude.
 */
export function renderMarkdown(bubbles: RawBubble[], meta: RenderMeta): string {
  const out: string[] = [`# ${meta.title || 'Chat'}`, '']
  for (const b of bubbles) {
    const body = b.steps.map(stepToMarkdown).filter(s => s.length > 0).join('\n\n')
    out.push(roleHeading(b), '', body || '_(empty)_', '', '---', '')
  }
  return out.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n'
}

// ── HTML renderer (self-contained, no external assets) ────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function md(text: string): string {
  return marked.parse(text, { async: false }) as string
}

function stepToHtml(step: Step): string {
  switch (step.kind) {
    case 'text':
      return `<div class="md">${md(step.text)}</div>`
    case 'thinking':
      return `<details class="thinking"><summary>Thinking</summary><div class="md">${md(step.text)}</div></details>`
    case 'tool': {
      let input = step.input
      try { input = JSON.stringify(JSON.parse(step.input), null, 2) } catch { /* leave as-is */ }
      const shots = (step.screenshotUrls ?? [])
        .map((u, i) => `<img src="${escapeHtml(u)}" alt="screenshot ${i + 1}" />`).join('')
      const result = (step.result !== undefined && step.result !== '')
        ? `<div class="tool-result${step.isError ? ' error' : ''}"><pre>${escapeHtml(step.result)}</pre></div>`
        : ''
      return `<details class="tool"><summary>Tool call: <code>${escapeHtml(step.name)}</code></summary>` +
        `<pre class="tool-input">${escapeHtml(input)}</pre>${result}${shots}</details>`
    }
    case 'attachment':
      return step.attachmentKind === 'image'
        ? `<img class="attachment" src="${escapeHtml(step.url)}" alt="${escapeHtml(step.filename)}" />`
        : `<a class="attachment" href="${escapeHtml(step.url)}">${escapeHtml(step.filename)}</a>`
  }
}

const HTML_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #f6f7f9; color: #1a1a1a; }
main { max-width: 820px; margin: 0 auto; padding: 24px 16px 96px; }
h1.chat-title { font-size: 1.5rem; margin: 8px 0 4px; }
.meta { color: #888; font-size: 0.85rem; margin-bottom: 24px; }
.turn { margin: 0 0 20px; padding: 16px 18px; border-radius: 12px; }
.turn.user { background: #e7effe; }
.turn.assistant { background: #fff; border: 1px solid #e4e6eb; }
.role { font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em;
  color: #666; margin-bottom: 8px; }
.md :first-child { margin-top: 0; }
.md :last-child { margin-bottom: 0; }
.md pre { background: #0d1117; color: #e6edf3; padding: 12px; border-radius: 8px; overflow-x: auto; }
.md code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
.md :not(pre) > code { background: rgba(135,131,120,0.15); padding: 0.15em 0.35em; border-radius: 4px; }
.md table { border-collapse: collapse; } .md th, .md td { border: 1px solid #ccc; padding: 4px 8px; }
.md img, img.attachment { max-width: 100%; border-radius: 8px; }
details.thinking, details.tool { margin: 10px 0; padding: 8px 12px; border-radius: 8px;
  background: rgba(135,131,120,0.1); font-size: 0.92rem; }
details summary { cursor: pointer; font-weight: 600; color: #555; }
.tool-input, .tool-result pre { background: #0d1117; color: #e6edf3; padding: 10px; border-radius: 6px;
  overflow-x: auto; font-size: 0.85rem; }
.tool-result.error pre { color: #ffb4b4; }
a.attachment { display: inline-block; margin: 6px 0; }
footer { text-align: center; color: #aaa; font-size: 0.8rem; margin-top: 40px; }
@media (prefers-color-scheme: dark) {
  body { background: #17181c; color: #e6e6e6; }
  .turn.user { background: #1e2a44; }
  .turn.assistant { background: #202226; border-color: #313338; }
  .role, details summary { color: #9aa0a6; }
  .md th, .md td { border-color: #3a3d42; }
}
`

/**
 * Render display bubbles to a self-contained HTML document (inline CSS, no external assets), so the
 * shared page reads immediately with no client-side API calls. Callers apply filterSteps() first.
 */
export function renderHtml(bubbles: RawBubble[], meta: RenderMeta): string {
  const title = escapeHtml(meta.title || 'Shared chat')
  const turns = bubbles.map(b => {
    const body = b.steps.map(stepToHtml).join('\n')
    const label = b.role === 'user' ? 'User' : `Assistant${b.model ? ` · ${escapeHtml(b.model)}` : ''}`
    return `<section class="turn ${b.role}"><div class="role">${label}</div>${body}</section>`
  }).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title}</title>
<style>${HTML_STYLE}</style>
</head>
<body>
<main>
<h1 class="chat-title">${title}</h1>
<div class="meta">Shared read-only chat · Chatrock</div>
${turns}
<footer>Rendered by Chatrock</footer>
</main>
</body>
</html>
`
}
