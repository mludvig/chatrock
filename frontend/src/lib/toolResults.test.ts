import { describe, it, expect } from 'vitest'
import { parseSearchResults } from './toolResults'

describe('parseSearchResults', () => {
  it('returns parsed results for web_search with valid JSON', () => {
    const json = JSON.stringify({
      results: [
        { title: 'Page A', url: 'https://a.com', description: 'Desc A' },
        { title: 'Page B', url: 'https://b.com', description: 'Desc B' },
      ],
    })
    const res = parseSearchResults('web_search', json, false)
    expect(res).toEqual([
      { title: 'Page A', url: 'https://a.com', description: 'Desc A' },
      { title: 'Page B', url: 'https://b.com', description: 'Desc B' },
    ])
  })

  it('returns undefined when isError is true', () => {
    const json = JSON.stringify({ results: [{ title: 'T', url: 'https://x.com', description: 'D' }] })
    expect(parseSearchResults('web_search', json, true)).toBeUndefined()
  })

  it('returns undefined when result JSON is invalid', () => {
    expect(parseSearchResults('web_search', 'not json', false)).toBeUndefined()
  })

  it('returns undefined for unknown tool names', () => {
    const json = JSON.stringify({ results: [{ title: 'T', url: 'https://x.com', description: 'D' }] })
    expect(parseSearchResults('web_browse', json, false)).toBeUndefined()
  })

  it('returns a single card array for web_fetch with valid JSON', () => {
    const json = JSON.stringify({
      result: { title: 'Example Page', url: 'https://example.com', description: 'A page' },
      text: 'page body...',
    })
    const res = parseSearchResults('web_fetch', json, false)
    expect(res).toEqual([{ title: 'Example Page', url: 'https://example.com', description: 'A page' }])
  })

  it('returns undefined for web_fetch when result key is absent', () => {
    const json = JSON.stringify({ text: 'body only' })
    expect(parseSearchResults('web_fetch', json, false)).toBeUndefined()
  })

  it('returns undefined when result is missing/undefined', () => {
    expect(parseSearchResults('web_search', undefined, false)).toBeUndefined()
  })

  it('returns undefined when results key is absent in JSON', () => {
    expect(parseSearchResults('web_search', JSON.stringify({ data: [] }), false)).toBeUndefined()
  })
})
