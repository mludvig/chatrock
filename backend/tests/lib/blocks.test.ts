import { capToolResultText, TOOL_RESULT_CAP } from '../../src/lib/blocks'

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
