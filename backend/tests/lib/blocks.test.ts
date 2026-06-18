import { capToolResultText, TOOL_RESULT_CAP, TOOL_RESULTS_ROUND_CAP } from '../../src/lib/blocks'

test('capToolResultText returns text unchanged when within limit', () => {
  const short = 'x'.repeat(100)
  expect(capToolResultText(short)).toBe(short)
})

test('capToolResultText caps text at TOOL_RESULT_CAP and appends truncation marker', () => {
  const long = 'a'.repeat(TOOL_RESULT_CAP + 1000)
  const result = capToolResultText(long)
  expect(result.length).toBeLessThanOrEqual(TOOL_RESULT_CAP + 50) // marker adds ~30 chars
  expect(result).toContain('[... truncated ...]')
  expect(result.startsWith('a')).toBe(true)
})

test('capToolResultText is idempotent — capping twice gives the same result', () => {
  const long = 'b'.repeat(TOOL_RESULT_CAP + 5000)
  const once = capToolResultText(long)
  const twice = capToolResultText(once)
  expect(twice).toBe(once)
})

test('capToolResultText handles empty string', () => {
  expect(capToolResultText('')).toBe('')
})

test('capToolResultText accepts a custom maxBytes override', () => {
  const text = 'x'.repeat(1000)
  const result = capToolResultText(text, 100)
  expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(100)
  expect(result).toContain('[... truncated ...]')
})

test('capToolResultText measures multi-byte UTF-8 content by bytes, not characters', () => {
  // Each 'é' is 2 bytes in UTF-8 but 1 character — a char-counting cap would let this
  // exceed maxBytes; a byte-counting cap must not.
  const text = 'é'.repeat(1000)
  const result = capToolResultText(text, 500)
  expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(500)
})

test('capToolResultText never splits a multi-byte codepoint at the truncation boundary', () => {
  const text = '日本語のテキストです。'.repeat(50)
  const result = capToolResultText(text, 137)
  // A corrupted split would produce the replacement character or throw on re-encode
  expect(result).not.toContain('�')
  expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(137)
})

test('TOOL_RESULTS_ROUND_CAP is smaller than the DynamoDB 400KB item limit, with headroom', () => {
  expect(TOOL_RESULTS_ROUND_CAP).toBeLessThan(400_000)
})
