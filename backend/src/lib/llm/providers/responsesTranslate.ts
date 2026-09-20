// Pure Block[]/NeutralMessage[] <-> Bedrock Responses (OpenAI Responses API) item[]
// translation. No I/O, no SDK client calls — just the two directions, mirroring
// converseTranslate.ts's role for the Converse provider. Kept separate from
// bedrockResponses.ts (which owns the wire protocol / streaming) so it's trivially
// unit-testable.
//
// Structural difference from converseTranslate: Converse's ContentBlock[] nests
// everything (including tool calls/results) inside one role-tagged Message.
// Responses' `input` is a FLAT array of items — a tool_call/tool_result/thinking
// block becomes its own top-level item, not part of a role/content message. So
// translation from the neutral format operates on the whole NeutralMessage[]
// array (fromNeutralMessages), not per-message like Converse's fromNeutralMessage.
//
// See docs/adr/0048-openai-models-on-bedrock-runtime.md for the empirically-confirmed
// wire shapes this maps onto (SSE event names, call_id round-tripping, reasoning
// encrypted payload sizes).
import type { ResponseInputItem, ResponseOutputItem, ResponseInputContent } from 'openai/resources/responses/responses'
import {
  type Block, type NeutralMessage, type MediaSource, type DocumentFormat,
  type ToolResultEntry as NeutralToolResultEntry,
  encodeOpaque, decodeOpaque,
} from '../blocks'

interface ResponsesReasoning {
  id: string
  encryptedContent?: string
}

// ── media helpers ────────────────────────────────────────────────────────────

function mediaSourceToDataUrl(source: MediaSource, mime: string): string {
  if ('bytes' in source) return `data:${mime};base64,${Buffer.from(source.bytes).toString('base64')}`
  // Not hydrated to bytes before reaching here — shouldn't happen in practice
  // (the caller hydrates from S3 the same way Converse's path does), but fail
  // soft rather than throw so a translation bug never becomes an outage.
  return source.s3Uri
}

function mediaSourceToText(source: MediaSource): string {
  if ('bytes' in source) return Buffer.from(source.bytes).toString('utf8')
  return `[document at ${source.s3Uri} — not hydrated]`
}

const INLINE_TEXT_DOCUMENT_FORMATS: DocumentFormat[] = ['txt', 'md', 'csv']

// ── output items (one round's result) -> neutral ────────────────────────────

export function toNeutral(items: ResponseOutputItem[]): Block[] {
  const out: Block[] = []
  for (const item of items) {
    if (item.type === 'message') {
      for (const part of item.content) {
        if (part.type === 'output_text' && part.text) {
          out.push({ kind: 'text', text: part.text })
        } else if (part.type === 'refusal' && part.refusal) {
          // Surfaced as text rather than silently dropped.
          out.push({ kind: 'text', text: part.refusal })
        }
      }
    } else if (item.type === 'reasoning') {
      const text = item.summary.map(s => s.text).join('\n\n')
      out.push({
        kind: 'thinking',
        text,
        opaque: encodeOpaque('bedrock-responses', {
          id: item.id,
          ...(item.encrypted_content ? { encryptedContent: item.encrypted_content } : {}),
        } satisfies ResponsesReasoning),
      })
    } else if (item.type === 'function_call') {
      out.push({
        kind: 'tool_call',
        callId: item.call_id,
        name: item.name,
        input: (() => { try { return JSON.parse(item.arguments) } catch { return {} } })(),
      })
    }
    // Other item types (web_search_call, computer_call, image_generation_call, etc.)
    // aren't produced by this app's tool set and are dropped — same convention as
    // converseTranslate.toNeutral dropping cachePoint.
  }
  return out
}

// ── neutral history -> input items (flat; see file header) ─────────────────

function toolResultOutput(entries: NeutralToolResultEntry[]): string | Array<{ type: 'input_text'; text: string } | { type: 'input_image'; detail: 'auto'; image_url: string }> {
  const hasImage = entries.some(e => e.kind === 'image')
  if (!hasImage) {
    return entries.filter((e): e is Extract<NeutralToolResultEntry, { kind: 'text' }> => e.kind === 'text').map(e => e.text).join('\n\n')
  }
  return entries.map(e => e.kind === 'text'
    ? { type: 'input_text' as const, text: e.text }
    : { type: 'input_image' as const, detail: 'auto' as const, image_url: mediaSourceToDataUrl(e.image.source, `image/${e.image.format}`) })
}

export function fromNeutralMessages(messages: NeutralMessage[]): ResponseInputItem[] {
  const out: ResponseInputItem[] = []

  for (const msg of messages) {
    let pending: ResponseInputContent[] = []
    const flush = () => {
      if (pending.length === 0) return
      out.push({ role: msg.role, content: pending } as ResponseInputItem)
      pending = []
    }

    for (const block of msg.content) {
      switch (block.kind) {
        case 'text':
          pending.push(
            msg.role === 'assistant'
              ? ({ type: 'output_text', text: block.text, annotations: [] } as unknown as ResponseInputContent)
              : { type: 'input_text', text: block.text },
          )
          break

        case 'image':
          pending.push({ type: 'input_image', detail: 'auto', image_url: mediaSourceToDataUrl(block.image.source, `image/${block.image.format}`) })
          break

        case 'document':
          if (INLINE_TEXT_DOCUMENT_FORMATS.includes(block.document.format)) {
            pending.push({ type: 'input_text', text: `<document name="${block.document.name}">\n${mediaSourceToText(block.document.source)}\n</document>` })
          } else {
            pending.push({ type: 'input_file', filename: block.document.name, file_data: mediaSourceToDataUrl(block.document.source, 'application/pdf') })
          }
          break

        case 'thinking': {
          flush()
          // Foreign/absent opaque -> drop (defense in depth; sanitizeHistory in
          // bedrockResponses.ts is the primary filter run before this).
          if (!block.opaque || block.opaque.provider !== 'bedrock-responses') break
          const { id, encryptedContent } = decodeOpaque<ResponsesReasoning>(block.opaque)
          out.push({
            type: 'reasoning',
            id,
            summary: block.text ? [{ type: 'summary_text', text: block.text }] : [],
            ...(encryptedContent ? { encrypted_content: encryptedContent } : {}),
          } as ResponseInputItem)
          break
        }

        case 'tool_call':
          flush()
          out.push({ type: 'function_call', call_id: block.callId, name: block.name, arguments: JSON.stringify(block.input) } as ResponseInputItem)
          break

        case 'tool_result':
          flush()
          out.push({ type: 'function_call_output', call_id: block.callId, output: toolResultOutput(block.entries) } as ResponseInputItem)
          break
      }
    }
    flush()
  }

  return out
}
