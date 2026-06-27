import { describe, it, expect } from 'vitest'
import { newId } from './ids'

describe('newId', () => {
  it('returns a 26-character lowercase Crockford-base32 string', () => {
    const id = newId()
    expect(id).toHaveLength(26)
    expect(id).toBe(id.toLowerCase())
    expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/)
  })

  it('never contains uppercase characters', () => {
    for (let i = 0; i < 20; i++) {
      expect(newId()).not.toMatch(/[A-Z]/)
    }
  })
})
