import type { Tool, ToolResultBlock } from '@aws-sdk/client-bedrock-runtime'

// ── Jina tool definitions for Bedrock ────────────────────────────────────────

export const WEB_TOOLS: Tool[] = [
  {
    toolSpec: {
      name: 'web_search',
      description: 'Search the web for current information. Returns titles, URLs and snippets of the top results. Use this when you need up-to-date information or facts you are not sure about.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query' },
          },
          required: ['query'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'web_fetch',
      description: 'Fetch and read the full content of a web page. Returns the page as clean readable text. Use this to read a specific URL.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to fetch' },
          },
          required: ['url'],
        },
      },
    },
  },
]

// ── Tool executors ────────────────────────────────────────────────────────────

const JINA_KEY = process.env.JINA_API_KEY ?? ''

export async function executeTool(name: string, input: Record<string, string>): Promise<ToolResultBlock> {
  try {
    if (name === 'web_search') {
      const result = await jinaSearch(input.query)
      return { toolUseId: '', content: [{ text: result }], status: 'success' }
    }
    if (name === 'web_fetch') {
      const result = await jinaFetch(input.url)
      return { toolUseId: '', content: [{ text: result }], status: 'success' }
    }
    return { toolUseId: '', content: [{ text: `Unknown tool: ${name}` }], status: 'error' }
  } catch (err) {
    return { toolUseId: '', content: [{ text: `Tool error: ${String(err)}` }], status: 'error' }
  }
}

export interface SearchResult {
  title: string
  url: string
  description: string
}

async function jinaSearch(query: string): Promise<string> {
  const url = `https://s.jina.ai/${encodeURIComponent(query)}`
  const headers: Record<string, string> = { 'Accept': 'application/json' }
  if (JINA_KEY) headers['Authorization'] = `Bearer ${JINA_KEY}`

  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`Jina search failed: ${res.status} ${await res.text()}`)

  const json = await res.json() as { data?: Array<{ title: string; url: string; description: string }> }
  const results = (json.data ?? []).slice(0, 5).map(r => ({
    title: r.title ?? '',
    url: r.url ?? '',
    description: r.description ?? '',
  }))

  if (results.length === 0) return JSON.stringify({ results: [], text: 'No results found.' })

  // Also provide a plain-text version the model can cite from
  const text = results.map((r, i) =>
    `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.description}`
  ).join('\n\n')

  return JSON.stringify({ results, text })
}

async function jinaFetch(url: string): Promise<string> {
  const jinaUrl = `https://r.jina.ai/${url}`
  const headers: Record<string, string> = { 'Accept': 'text/plain' }
  if (JINA_KEY) headers['Authorization'] = `Bearer ${JINA_KEY}`

  const res = await fetch(jinaUrl, { headers })
  if (!res.ok) throw new Error(`Jina fetch failed: ${res.status}`)

  const text = await res.text()
  // Cap at ~8k chars to avoid blowing the context window
  return text.length > 8000 ? text.slice(0, 8000) + '\n\n[... truncated ...]' : text
}
