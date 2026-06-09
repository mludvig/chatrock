// ── Block-level helpers for verbatim per-turn storage (format C) ─────────────

// Maximum character length for a single tool-result text payload stored in
// DynamoDB.  A single item is limited to 400 KB; large search/fetch results
// are the main risk.  Cap at ~30 KB which is generous for any reasonable
// result while staying safely below the item size limit.
export const TOOL_RESULT_CAP = 30_000

const TRUNCATION_MARKER = '\n\n[... truncated ...]'

/**
 * Cap a tool-result text to TOOL_RESULT_CAP characters.
 * Idempotent: if the string is already within the limit (including an existing
 * marker) it is returned unchanged.
 */
export function capToolResultText(text: string): string {
  if (text.length <= TOOL_RESULT_CAP) return text
  return text.slice(0, TOOL_RESULT_CAP) + TRUNCATION_MARKER
}
