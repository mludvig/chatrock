import { describe, it, expect } from 'vitest'
import { sanitizeUrl } from './MessageBubble'

describe('sanitizeUrl', () => {
  it('allows https URLs', () => {
    expect(sanitizeUrl('https://example.com/path')).toBe('https://example.com/path')
  })

  it('allows http URLs', () => {
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com')
  })

  it('blocks javascript: URIs', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('#')
  })

  it('blocks javascript: with encoded colon', () => {
    expect(sanitizeUrl('javascript:void(0)')).toBe('#')
  })

  it('blocks data: URIs', () => {
    expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBe('#')
  })

  it('blocks empty string', () => {
    expect(sanitizeUrl('')).toBe('#')
  })

  it('blocks malformed URLs', () => {
    expect(sanitizeUrl('not a url at all')).toBe('#')
  })

  it('blocks ftp: scheme', () => {
    expect(sanitizeUrl('ftp://example.com/file')).toBe('#')
  })
})
