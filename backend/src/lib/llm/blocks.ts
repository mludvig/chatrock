// ── The neutral block format ──────────────────────────────────────────────────
//
// This is what lands in the DynamoDB `blocks` attribute (TurnRow.blocks) once
// llm/providers/*/translate wires it up. Nothing in it is Bedrock- or
// OpenAI-shaped — every provider's adapter translates to/from this at its own
// boundary. See backend/CLAUDE.md's "LLM providers" section for the design.

export type ProviderId = 'bedrock-converse' | 'bedrock-mantle'

/** Where binary content lives. `s3Uri` is the at-rest form; `bytes` is the
 *  hydrated/live form used only in-memory right before a provider call. */
export type MediaSource = { s3Uri: string } | { bytes: Uint8Array }

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp'
export type DocumentFormat = 'pdf' | 'txt' | 'md' | 'csv'

export interface ImageRef {
  format: ImageFormat
  source: MediaSource
}

export interface DocumentRef {
  format: DocumentFormat
  name: string
  source: MediaSource
  citations?: boolean
}

export interface TextBlock {
  kind: 'text'
  text: string
}

/** Provider-private continuation material. Replayed VERBATIM to the same
 *  provider, DROPPED when the target provider differs (see each provider's
 *  sanitizeHistory). Never rendered, never sent to a client, never inspected
 *  outside its owning adapter. `data` is base64(JSON(...)) whose inner shape
 *  is entirely the adapter's business — versioned via `v` so a provider can
 *  evolve its own encoding without touching anyone else's stored rows. */
export interface Opaque {
  provider: ProviderId
  v: 1
  data: string
}

export interface ThinkingBlock {
  kind: 'thinking'
  /** Human-visible reasoning. Bedrock Converse: the thinking text. Bedrock
   *  Mantle: the reasoning summary (may be empty even when opaque is present —
   *  reasoning continuity does not depend on a visible summary existing). */
  text: string
  redacted?: boolean
  opaque?: Opaque
}

export interface ToolCallBlock {
  kind: 'tool_call'
  /** Opaque; pairs with the matching ToolResultBlock.callId. Never rewritten
   *  in either direction between providers — see backend/CLAUDE.md. */
  callId: string
  name: string
  input: Record<string, unknown>
}

export type ToolResultEntry =
  | { kind: 'text'; text: string }
  | { kind: 'image'; image: ImageRef }

export interface ToolResultBlock {
  kind: 'tool_result'
  callId: string
  /** Convenience for rendering; not load-bearing for pairing. */
  name?: string
  entries: ToolResultEntry[]
  isError: boolean
}

export interface ImageBlock {
  kind: 'image'
  image: ImageRef
}

export interface DocumentBlock {
  kind: 'document'
  document: DocumentRef
}

export type Block =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ToolResultBlock
  | ImageBlock
  | DocumentBlock

export interface NeutralMessage {
  role: 'user' | 'assistant'
  content: Block[]
}

// ── Tool-result text caps (moved from lib/blocks.ts) ──────────────────────────

// Maximum byte size for a single tool-result text payload stored in DynamoDB.
// A single item is limited to 400 KB. Cap at ~30 KB which is generous for any
// individual result while staying safely below the item size limit.
export const TOOL_RESULT_CAP = 30_000

// Aggregate byte budget across ALL tool results in one round. A round can contain
// many parallel tool_use calls (e.g. the model fanning out N web_search calls at
// once) that all land in the same DynamoDB turn item — capping each individually
// at TOOL_RESULT_CAP doesn't bound their sum. The agentic loop divides this budget
// across the round's tool calls to derive each call's effective cap.
export const TOOL_RESULTS_ROUND_CAP = 300_000

const TRUNCATION_MARKER = '\n\n[... truncated ...]'
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, 'utf8')

// Largest character-length prefix of `text` whose UTF-8 byte length is <= maxBytes.
// Operates on JS string (UTF-16) slicing rather than raw byte slicing so it never
// splits a multi-byte codepoint.
function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo)
}

/**
 * Cap a tool-result text to maxBytes (default TOOL_RESULT_CAP), measured as UTF-8
 * byte length so multi-byte content (e.g. web search snippets) can't slip past the
 * DynamoDB item-size limit. Idempotent: if the string is already within the limit
 * (including an existing marker) it is returned unchanged.
 */
export function capToolResultText(text: string, maxBytes: number = TOOL_RESULT_CAP): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const truncated = truncateToBytes(text, Math.max(0, maxBytes - TRUNCATION_MARKER_BYTES))
  return truncated + TRUNCATION_MARKER
}

// ── Opaque helpers ─────────────────────────────────────────────────────────────

export function encodeOpaque(provider: ProviderId, data: unknown): Opaque {
  return { provider, v: 1, data: Buffer.from(JSON.stringify(data)).toString('base64') }
}

export function decodeOpaque<T>(opaque: Opaque): T {
  return JSON.parse(Buffer.from(opaque.data, 'base64').toString('utf8')) as T
}

// ── Legacy-shape detection (for the one-off migration script + read-time guard) ─

/**
 * True for a row already in the neutral format (every block has a `kind`
 * discriminant). False for a legacy row still in raw Bedrock ContentBlock shape
 * (pre-cutover data) — those need `bedrockConverse.toNeutral()` first.
 */
export function isNeutralBlocks(blocks: unknown[]): blocks is Block[] {
  return blocks.length === 0 || (typeof blocks[0] === 'object' && blocks[0] !== null && 'kind' in blocks[0])
}
