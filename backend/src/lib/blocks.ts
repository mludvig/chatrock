// ── Block-level helpers for verbatim per-turn storage (format C) ─────────────

// Maximum byte size for a single tool-result text payload stored in DynamoDB.
// A single item is limited to 400 KB. Cap at ~30 KB which is generous for any
// individual result while staying safely below the item size limit.
export const TOOL_RESULT_CAP = 30_000

// Aggregate byte budget across ALL tool results in one round. A round can contain
// many parallel tool_use calls (e.g. the model fanning out N web_search calls at
// once) that all land in the same DynamoDB turn item — capping each individually
// at TOOL_RESULT_CAP doesn't bound their sum. bedrock.ts divides this budget across
// the round's tool calls to derive each call's effective cap.
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
