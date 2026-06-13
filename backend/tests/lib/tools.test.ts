import { executeTool } from '../../src/lib/tools'

describe('web_fetch executor', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch })

  it('returns a structured card + full text', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { title: 'Example Domain', url: 'https://example.com', description: 'An example', content: 'Hello world body' },
      }),
    }) as unknown as typeof fetch

    const res = await executeTool('web_fetch', { url: 'https://example.com' })
    const payload = JSON.parse((res.content?.[0] as { text: string }).text)
    expect(payload.result).toMatchObject({ title: 'Example Domain', url: 'https://example.com', description: 'An example' })
    expect(payload.text).toContain('Hello world body')
  })

  it('truncates content longer than 8000 chars', async () => {
    const longContent = 'x'.repeat(9000)
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { title: 'Long Page', url: 'https://example.com/long', description: 'A long page', content: longContent },
      }),
    }) as unknown as typeof fetch

    const res = await executeTool('web_fetch', { url: 'https://example.com/long' })
    const payload = JSON.parse((res.content?.[0] as { text: string }).text)
    expect(payload.text).toContain('[... truncated ...]')
    expect(payload.text.length).toBeLessThan(9000)
  })

  it('falls back to url when title is missing', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { url: 'https://example.com/notitle', content: 'Some text' },
      }),
    }) as unknown as typeof fetch

    const res = await executeTool('web_fetch', { url: 'https://example.com/notitle' })
    const payload = JSON.parse((res.content?.[0] as { text: string }).text)
    expect(payload.result.title).toBe('https://example.com/notitle')
    expect(payload.result.url).toBe('https://example.com/notitle')
  })

  it('returns error status when fetch fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }) as unknown as typeof fetch

    const res = await executeTool('web_fetch', { url: 'https://example.com/fail' })
    expect(res.status).toBe('error')
  })
})
