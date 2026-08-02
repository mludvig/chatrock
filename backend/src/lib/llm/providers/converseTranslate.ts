// Pure Block[] <-> Bedrock Converse ContentBlock[] translation. No I/O, no SDK calls —
// just the two directions. Kept separate from bedrockConverse.ts (which owns the wire
// protocol) so it's trivially unit-testable and so its counterpart, mantleTranslate.ts,
// has an obvious sibling to mirror.
import type { ContentBlock, ToolResultContentBlock } from '@aws-sdk/client-bedrock-runtime'
import type { DocumentType } from '@smithy/types'
import {
  type Block, type NeutralMessage, type ImageFormat, type DocumentFormat, type MediaSource,
  encodeOpaque, decodeOpaque,
} from '../blocks'

interface AnthropicSignature { signature: string }
interface AnthropicRedacted { redactedContent: string } // base64

function mediaSourceToNeutral(source: { bytes?: Uint8Array; s3Location?: { uri?: string } } | undefined): MediaSource {
  if (source?.s3Location) return { s3Uri: source.s3Location.uri ?? '' }
  if (source?.bytes) return { bytes: source.bytes }
  return { s3Uri: '' }
}

function mediaSourceFromNeutral(source: MediaSource): { bytes: Uint8Array } | { s3Location: { uri: string } } {
  if ('bytes' in source) return { bytes: source.bytes }
  return { s3Location: { uri: source.s3Uri } }
}

function toolResultEntryToNeutral(entry: ToolResultContentBlock): { kind: 'text'; text: string } | { kind: 'image'; image: { format: ImageFormat; source: MediaSource } } | null {
  if ('text' in entry && entry.text !== undefined) return { kind: 'text', text: entry.text }
  if ('image' in entry && entry.image) {
    return { kind: 'image', image: { format: (entry.image.format ?? 'png') as ImageFormat, source: mediaSourceToNeutral(entry.image.source) } }
  }
  return null
}

function toolResultEntryFromNeutral(entry: { kind: 'text'; text: string } | { kind: 'image'; image: { format: ImageFormat; source: MediaSource } }): ToolResultContentBlock {
  if (entry.kind === 'text') return { text: entry.text }
  return { image: { format: entry.image.format, source: mediaSourceFromNeutral(entry.image.source) } } as ToolResultContentBlock
}

/** Bedrock Converse ContentBlock[] -> the neutral format. Used both for a freshly
 *  streamed turn's blocks and (via normalizeStoredBlocks) to upgrade legacy rows —
 *  pre-cutover data is, by definition, already in this exact shape. */
export function toNeutral(blocks: ContentBlock[]): Block[] {
  const out: Block[] = []
  for (const block of blocks) {
    if ('text' in block && block.text !== undefined) {
      out.push({ kind: 'text', text: block.text })
    } else if ('reasoningContent' in block && block.reasoningContent) {
      const rc = block.reasoningContent
      if ('redactedContent' in rc && rc.redactedContent) {
        out.push({
          kind: 'thinking',
          text: '',
          redacted: true,
          opaque: encodeOpaque('bedrock-converse', { redactedContent: Buffer.from(rc.redactedContent).toString('base64') } satisfies AnthropicRedacted),
        })
      } else if ('reasoningText' in rc && rc.reasoningText) {
        out.push({
          kind: 'thinking',
          text: rc.reasoningText.text ?? '',
          ...(rc.reasoningText.signature
            ? { opaque: encodeOpaque('bedrock-converse', { signature: rc.reasoningText.signature } satisfies AnthropicSignature) }
            : {}),
        })
      }
    } else if ('toolUse' in block && block.toolUse) {
      out.push({
        kind: 'tool_call',
        callId: block.toolUse.toolUseId ?? '',
        name: block.toolUse.name ?? '',
        input: (block.toolUse.input ?? {}) as Record<string, unknown>,
      })
    } else if ('toolResult' in block && block.toolResult) {
      const tr = block.toolResult
      const entries = (tr.content ?? []).map(toolResultEntryToNeutral).filter((e): e is NonNullable<typeof e> => e !== null)
      out.push({
        kind: 'tool_result',
        callId: tr.toolUseId ?? '',
        entries,
        isError: tr.status === 'error',
      })
    } else if ('image' in block && block.image) {
      out.push({
        kind: 'image',
        image: { format: (block.image.format ?? 'png') as ImageFormat, source: mediaSourceToNeutral(block.image.source) },
      })
    } else if ('document' in block && block.document) {
      const citations = block.document.citations as { enabled?: boolean } | undefined
      out.push({
        kind: 'document',
        document: {
          format: (block.document.format ?? 'txt') as DocumentFormat,
          name: block.document.name ?? 'attachment',
          source: mediaSourceToNeutral(block.document.source),
          ...(citations?.enabled !== undefined ? { citations: citations.enabled } : {}),
        },
      })
    }
    // cachePoint and any other unrecognized block kind are dropped — cachePoint is
    // never neutral (it's request shaping, injected fresh by the provider each call).
  }
  return out
}

/** The neutral format -> Bedrock Converse ContentBlock[]. Drops any ThinkingBlock
 *  whose opaque isn't ours (or is missing) — a foreign/absent signature is a hard
 *  Converse ValidationException. Caller (bedrockConverse's sanitizeHistory) is
 *  responsible for the empty-message/coalesce cleanup that follows. */
export function fromNeutral(blocks: Block[]): ContentBlock[] {
  const out: ContentBlock[] = []
  for (const block of blocks) {
    switch (block.kind) {
      case 'text':
        out.push({ text: block.text })
        break
      case 'thinking': {
        if (!block.opaque || block.opaque.provider !== 'bedrock-converse') break // foreign/absent — drop
        if (block.redacted) {
          const { redactedContent } = decodeOpaque<AnthropicRedacted>(block.opaque)
          out.push({ reasoningContent: { redactedContent: Buffer.from(redactedContent, 'base64') } })
        } else {
          const { signature } = decodeOpaque<AnthropicSignature>(block.opaque)
          out.push({ reasoningContent: { reasoningText: { text: block.text, signature } } })
        }
        break
      }
      case 'tool_call':
        out.push({ toolUse: { toolUseId: block.callId, name: block.name, input: block.input as DocumentType } })
        break
      case 'tool_result':
        out.push({
          toolResult: {
            toolUseId: block.callId,
            content: block.entries.map(toolResultEntryFromNeutral),
            status: block.isError ? 'error' : 'success',
          },
        })
        break
      case 'image':
        out.push({ image: { format: block.image.format, source: mediaSourceFromNeutral(block.image.source) } } as ContentBlock)
        break
      case 'document':
        out.push({
          document: {
            format: block.document.format,
            name: block.document.name,
            source: mediaSourceFromNeutral(block.document.source),
            citations: { enabled: block.document.citations === true },
          },
        } as ContentBlock)
        break
    }
  }
  return out
}

export function toNeutralMessage(msg: { role: 'user' | 'assistant'; content?: ContentBlock[] }): NeutralMessage {
  return { role: msg.role, content: toNeutral(msg.content ?? []) }
}

export function fromNeutralMessage(msg: NeutralMessage): { role: 'user' | 'assistant'; content: ContentBlock[] } {
  return { role: msg.role, content: fromNeutral(msg.content) }
}
