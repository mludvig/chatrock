/**
 * Tests for backend/src/lib/ids.ts — the only call site allowed to import
 * the `ulid` package directly. Every ID that becomes a DynamoDB sort key
 * (chatId/projectId/fileId/memId) must come from newId() so the whole
 * system shares one case and stays lexicographically sortable.
 */

import { decodeTime } from 'ulid'
import { newId } from '../../src/lib/ids'

test('newId returns a 26-character lowercase Crockford-base32 string', () => {
  const id = newId()
  expect(id).toHaveLength(26)
  expect(id).toBe(id.toLowerCase())
  expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/)
})

test('newId never contains uppercase characters', () => {
  for (let i = 0; i < 20; i++) {
    expect(newId()).not.toMatch(/[A-Z]/)
  }
})

test('decodes to a recent timestamp once re-uppercased (confirms it is a real, time-ordered ULID)', () => {
  const id = newId()
  const decoded = decodeTime(id.toUpperCase())
  expect(decoded).toBeGreaterThan(Date.now() - 5000)
  expect(decoded).toBeLessThanOrEqual(Date.now())
})

test('lowercasing preserves relative order between two IDs minted further apart than 1ms', async () => {
  const a = newId()
  await new Promise(r => setTimeout(r, 2))
  const b = newId()
  expect(a < b).toBe(true)
})
