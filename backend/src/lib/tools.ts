import type { Tool, ToolResultBlock } from '@aws-sdk/client-bedrock-runtime'
import { executeMemoryTool } from './memory'

// ── Tool execution context ────────────────────────────────────────────────────

export interface ToolContext {
  sub: string
}

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

// ── Memory tool spec ──────────────────────────────────────────────────────────

export const MEMORY_TOOL: Tool = {
  toolSpec: {
    name: 'manage_memory',
    description: "Manage your long-term memory of the user. Use operation 'remember' to save a new durable personal fact (name, location, profession, stated preferences, communication style). Use 'update' with a memId to correct an existing fact. Use 'forget' with a memId to remove a fact. The memId values are shown in brackets next to each memory in your memory list. Do NOT store task-specific or temporary details. Save facts the user would expect you to recall in future conversations.",
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['remember', 'update', 'forget'],
            description: "remember = save a new durable fact; update = correct an existing fact by id; forget = delete a fact by id",
          },
          text: {
            type: 'string',
            description: 'The durable fact about the user, concise. Required for remember and update.',
          },
          category: {
            type: 'string',
            enum: ['identity', 'preference', 'style', 'other'],
            description: 'Category of the fact. Required for remember; optional for update.',
          },
          memId: {
            type: 'string',
            description: 'Id of an existing memory (from the [memId] markers in the memory list). Required for update and forget.',
          },
        },
        required: ['operation'],
      },
    },
  },
}

// ── Tool executors ────────────────────────────────────────────────────────────

const JINA_KEY = process.env.JINA_API_KEY ?? ''

export async function executeTool(name: string, input: Record<string, string>, ctx: ToolContext): Promise<ToolResultBlock> {
  try {
    if (name === 'manage_memory') {
      return await executeMemoryTool(input, ctx)
    }
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
  const headers: Record<string, string> = { 'Accept': 'application/json' }
  if (JINA_KEY) headers['Authorization'] = `Bearer ${JINA_KEY}`

  const res = await fetch(jinaUrl, { headers })
  if (!res.ok) throw new Error(`Jina fetch failed: ${res.status}`)

  const json = await res.json() as {
    data?: { title?: string; url?: string; description?: string; content?: string }
  }
  const d = json.data ?? {}
  const content = d.content ?? ''
  // Cap the page body at ~8k chars to protect the context window
  const text = content.length > 8000 ? content.slice(0, 8000) + '\n\n[... truncated ...]' : content
  const result = {
    title: d.title ?? d.url ?? url,
    url: d.url ?? url,
    description: d.description ?? '',
  }
  return JSON.stringify({ result, text })
}
