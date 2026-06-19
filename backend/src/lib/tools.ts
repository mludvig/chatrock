import type { Tool, ToolResultBlock, ToolResultContentBlock } from '@aws-sdk/client-bedrock-runtime'
import { executeMemoryTool, executeProjectMemoryTool } from './memory'
import { executeProjectReadFileTool, executeProjectReadChatTool } from './projectContext'
import { callGatewayTool } from './agentcore/gateway'
import type { BrowserStep } from './agentcore/browser'

// ── Tool execution context ────────────────────────────────────────────────────

export interface ToolContext {
  sub: string
  projectId?: string
  chatId?: string
  webSearchProvider?: 'jina' | 'agentcore'
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

// ── Browser tool spec ─────────────────────────────────────────────────────────
//
// Backed by Amazon Bedrock AgentCore Browser, driven by the official `@playwright/mcp`
// package embedded in-process (see ./agentcore/browser.ts). The allowed `tool` names below
// are a curated subset of the real package's tool catalogue — its actual params, copied
// verbatim from the installed package so the model gets accurate guidance. Excluded
// deliberately: browser_evaluate / browser_run_code_unsafe (arbitrary JS execution),
// browser_file_upload / browser_drop (local filesystem access), browser_network_request(s)
// (out of scope for v1) — none of these are needed for read/navigate/click/type/screenshot
// workflows and they widen the security surface of a tool driven by arbitrary chat prompts.

export const ALLOWED_BROWSER_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_click',
  'browser_type',
  'browser_hover',
  'browser_press_key',
  'browser_select_option',
  'browser_drag',
  'browser_resize',
  'browser_handle_dialog',
  'browser_wait_for',
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_console_messages',
  'browser_fill_form',
  'browser_tabs',
] as const

export const MAX_BROWSER_STEPS = 15
export const MAX_BROWSER_SCREENSHOTS = 4

// ── Browser shortcut tool specs (Core) ────────────────────────────────────────
//
// These cover the common 80% case — one URL in, one artifact out — without the model
// having to construct a `steps` array. Both lower to a fixed BrowserStep[] and reuse
// runBrowserSteps; no new session machinery.

export const TAKE_SCREENSHOT_TOOL: Tool = {
  toolSpec: {
    name: 'take_screenshot',
    description: "Take a screenshot of a web page in a real, isolated browser — including pages that need JavaScript to render (dynamic single-page apps). Returns one image. Use this for 'show me what X looks like' / 'screenshot this page'. For multi-step interactions (click, type, navigate between pages) or more than one screenshot, use browse_web instead.",
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The page URL to screenshot.' },
          fullPage: { type: 'boolean', description: 'Capture the full scrollable page, not just the visible viewport. Default true.' },
          width: { type: 'number', description: 'Viewport width in pixels (optional; defaults to a standard desktop size).' },
          height: { type: 'number', description: 'Viewport height in pixels (optional).' },
          format: { type: 'string', enum: ['png', 'jpeg'], description: "Image format. Default 'png'." },
        },
        required: ['url'],
      },
    },
  },
}

export const GET_RENDERED_PAGE_TOOL: Tool = {
  toolSpec: {
    name: 'get_rendered_page',
    description: "Load a web page in a real browser (runs JavaScript) and return its rendered content as a structured accessibility-tree snapshot — text only, no image. Use this for JavaScript-heavy / single-page-app pages where web_fetch's static HTML fetch would miss content (the word 'rendered' is the cue: this tool executes the page's JS, web_fetch does not). For plain/static pages, prefer the faster web_fetch. If you also need a visual, use take_screenshot.",
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The page URL to load.' },
          width: { type: 'number', description: 'Viewport width in pixels (optional).' },
          height: { type: 'number', description: 'Viewport height in pixels (optional).' },
        },
        required: ['url'],
      },
    },
  },
}

export const BROWSER_TOOL: Tool = {
  toolSpec: {
    name: 'browse_web',
    description: `Run a sequence of browser actions in one isolated session — the session opens, runs every step in order, and closes automatically when this call returns. browse_web is the ONLY tool here: browser_navigate, browser_click, etc. below are NOT separate top-level tools, they only exist as entries inside this call's "steps" array.

For the common case of just grabbing a screenshot or a JS-rendered page's content, prefer the simpler take_screenshot / get_rendered_page tools instead. Use browse_web only when you need multiple actions in sequence — click, type, navigate between pages, wait for something, fill a form — or more than one screenshot in one session.

Example call:
{"steps": [
  {"tool": "browser_navigate", "params": {"url": "https://example.com"}},
  {"tool": "browser_snapshot", "params": {}},
  {"tool": "browser_click", "params": {"target": "e3", "element": "Sign in button"}},
  {"tool": "browser_take_screenshot", "params": {"fullPage": true}}
]}

Call browser_snapshot first to see the page's accessibility tree (with a 'target' reference for each interactive element) before clicking/typing — most interaction tools take a 'target' (the exact reference from a prior snapshot, or a unique CSS selector) and an optional 'element' (a short human-readable description of what you're targeting). Max ${MAX_BROWSER_STEPS} steps and ${MAX_BROWSER_SCREENSHOTS} screenshots per call.

Allowed step "tool" values and their params:
- browser_navigate { url }
- browser_navigate_back {}
- browser_snapshot { target?, depth?, boxes? } — accessibility tree of the page, better than a screenshot for deciding what to click
- browser_take_screenshot { target?, element?, type?: 'png'|'jpeg', fullPage? } — visual screenshot, shown to you as an image
- browser_click { target, element?, doubleClick?, button?: 'left'|'right'|'middle', modifiers? }
- browser_type { target, element?, text, submit?, slowly? }
- browser_hover { target, element? }
- browser_select_option { target, element?, values: string[] }
- browser_drag { startTarget, startElement?, endTarget, endElement? }
- browser_press_key { key } — e.g. 'Enter', 'ArrowLeft', 'a'
- browser_fill_form { fields: [{ target, element?, name, type: 'textbox'|'checkbox'|'radio'|'combobox'|'slider', value }] }
- browser_wait_for { time?, text?, textGone? } — wait seconds, or for text to appear/disappear
- browser_handle_dialog { accept, promptText? } — accept/dismiss a JS alert/confirm/prompt
- browser_resize { width, height }
- browser_console_messages { level: 'error'|'warning'|'info'|'debug', all? } — browser console/JS logs
- browser_tabs { action: 'list'|'new'|'close'|'select', index?, url? }`,
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'Ordered list of browser actions to run in one session.',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string', enum: [...ALLOWED_BROWSER_TOOLS] },
                params: { type: 'object', description: 'Params for this tool — see the tool description for the shape per tool name.' },
              },
              required: ['tool'],
            },
          },
        },
        required: ['steps'],
      },
    },
  },
}

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

// ── Project memory tool spec ──────────────────────────────────────────────────

export const MANAGE_PROJECT_MEMORY_TOOL: Tool = {
  toolSpec: {
    name: 'manage_project_memory',
    description: "Manage your long-term memory of this project. Use operation 'remember' to save a new durable project fact (architectural decisions, naming conventions, stable domain facts, constraints, glossary terms). Use 'update' with a memId to correct an existing fact. Use 'forget' with a memId to remove a fact. The memId values are shown in brackets next to each memory in your project memory list. Do NOT store personal user facts here — those belong in manage_memory.",
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['remember', 'update', 'forget'],
          },
          text: {
            type: 'string',
            description: 'The durable project fact, concise. Required for remember and update.',
          },
          category: {
            type: 'string',
            enum: ['decision', 'convention', 'fact', 'constraint', 'glossary', 'other'],
          },
          memId: {
            type: 'string',
            description: 'Id of an existing project memory. Required for update and forget.',
          },
        },
        required: ['operation'],
      },
    },
  },
}

// ── Project read tool specs ───────────────────────────────────────────────────

export const READ_PROJECT_FILE_TOOL: Tool = {
  toolSpec: {
    name: 'read_project_file',
    description: "Read a file from the current project. Use detail:'summary' first to get the detailed summary — use this to decide if the full file is needed. Use detail:'full' to get the complete file content. Always prefer 'summary' before 'full'. The fileId values are shown in brackets in the project file manifest.",
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'The file id from the project manifest (in [brackets]).' },
          detail: {
            type: 'string',
            enum: ['summary', 'full'],
            description: "'summary' = detailed description (decide if you need more). 'full' = complete content.",
          },
        },
        required: ['fileId', 'detail'],
      },
    },
  },
}

export const READ_PROJECT_CHAT_TOOL: Tool = {
  toolSpec: {
    name: 'read_project_chat',
    description: "Read another chat from the current project. Use detail:'summary' first to get the chat summary — use this to decide if the full transcript is needed. Use detail:'full' to get the complete chat transcript. Always prefer 'summary' before 'full'. The chatId values are shown in brackets in the project chat manifest.",
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'The chat id from the project manifest (in [brackets]).' },
          detail: {
            type: 'string',
            enum: ['summary', 'full'],
            description: "'summary' = 1-3 sentence overview (decide if you need more). 'full' = complete transcript.",
          },
        },
        required: ['chatId', 'detail'],
      },
    },
  },
}

// ── Tool executors ────────────────────────────────────────────────────────────

const JINA_KEY = process.env.JINA_API_KEY ?? ''

export async function executeTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResultBlock> {
  try {
    if (name === 'manage_memory') {
      return await executeMemoryTool(input as Record<string, string>, ctx)
    }
    if (name === 'manage_project_memory') {
      if (!ctx.projectId) return { toolUseId: '', content: [{ text: 'No project context' }], status: 'error' }
      return await executeProjectMemoryTool(input as Record<string, string>, { projectId: ctx.projectId })
    }
    if (name === 'read_project_file') {
      if (!ctx.projectId) return { toolUseId: '', content: [{ text: 'No project context' }], status: 'error' }
      return await executeProjectReadFileTool(input as Record<string, string>, ctx)
    }
    if (name === 'read_project_chat') {
      if (!ctx.projectId) return { toolUseId: '', content: [{ text: 'No project context' }], status: 'error' }
      return await executeProjectReadChatTool(input as Record<string, string>, ctx)
    }
    if (name === 'web_search') {
      const provider = ctx.webSearchProvider === 'agentcore' ? 'agentcore' : 'jina'
      const query = input.query as string
      const result = provider === 'agentcore' ? await agentcoreSearch(query) : await jinaSearch(query)
      console.log(JSON.stringify({ event: 'web_search', provider, result: 'success' }))
      return { toolUseId: '', content: [{ text: result }], status: 'success' }
    }
    if (name === 'web_fetch') {
      const result = await jinaFetch(input.url as string)
      return { toolUseId: '', content: [{ text: result }], status: 'success' }
    }
    if (name === 'browse_web') {
      return await executeBrowserTool(input, ctx)
    }
    if (name === 'take_screenshot') {
      return await executeTakeScreenshotTool(input, ctx)
    }
    if (name === 'get_rendered_page') {
      return await executeGetRenderedPageTool(input, ctx)
    }
    // The model sometimes tries to call a browse_web step name (e.g. "browser_take_screenshot")
    // as if it were its own top-level tool — give it a self-correcting hint instead of a bare
    // "unknown tool" (these are exactly the step names browse_web's description documents).
    if ((ALLOWED_BROWSER_TOOLS as readonly string[]).includes(name)) {
      return {
        toolUseId: '',
        content: [{ text: `"${name}" is not a standalone tool. Either call browse_web with steps: [{ "tool": "${name}", "params": {...} }, ...], or — if you just need one screenshot or one page's rendered content — use take_screenshot / get_rendered_page instead.` }],
        status: 'error',
      }
    }
    return { toolUseId: '', content: [{ text: `Unknown tool: ${name}` }], status: 'error' }
  } catch (err) {
    return { toolUseId: '', content: [{ text: `Tool error: ${String(err)}` }], status: 'error' }
  }
}

interface RawBrowserStep {
  tool?: unknown
  params?: unknown
}

// Lazy import: @playwright/mcp (and its transitive playwright/playwright-core deps) is
// only bundled with the ws-sendMessage Lambda (see esbuild.config.mjs). A static top-level
// import here would make every Lambda that transitively imports tools.ts via bedrock.ts
// (e.g. http/chats.ts's converseOnce for retitling) eagerly require a module they don't
// ship, crashing at cold start. Deferring the import to call time means it's only ever
// resolved inside the one Lambda that actually invokes this function.
async function getRunBrowserSteps() {
  const { runBrowserSteps } = await import('./agentcore/browser')
  return runBrowserSteps
}

// Shared by browse_web / take_screenshot / get_rendered_page: turns the mechanical
// per-step results from runBrowserSteps into Bedrock ToolResultContentBlock[].
function browserResultsToContent(results: Array<{ tool: string; text: string[]; images: Array<{ format: string; bytes: Uint8Array }>; error?: string }>): { content: ToolResultContentBlock[]; screenshotsFound: number } {
  const content: ToolResultContentBlock[] = []
  let screenshotsFound = 0
  for (const r of results) {
    for (const t of r.text) content.push({ text: `### ${r.tool}\n${t}` })
    for (const img of r.images) {
      content.push({ image: { format: img.format as 'png' | 'jpeg', source: { bytes: img.bytes } } } as ToolResultContentBlock)
      screenshotsFound++
    }
    if (r.error) content.push({ text: `### ${r.tool} (error)\n${r.error}` })
  }
  if (content.length === 0) content.push({ text: 'No output' })
  return { content, screenshotsFound }
}

// Optional width/height -> a leading browser_resize step, omitted when neither is given.
function resizeSteps(width: unknown, height: unknown): BrowserStep[] {
  if (typeof width !== 'number' || typeof height !== 'number') return []
  return [{ tool: 'browser_resize', params: { width, height } }]
}

async function executeBrowserTool(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResultBlock> {
  const rawSteps = Array.isArray(input.steps) ? input.steps as RawBrowserStep[] : []

  if (rawSteps.length === 0) {
    return {
      toolUseId: '',
      content: [{ text: 'browse_web requires a non-empty "steps" array — e.g. {"steps":[{"tool":"browser_navigate","params":{"url":"https://example.com"}},{"tool":"browser_take_screenshot","params":{"fullPage":true}}]}. browser_navigate, browser_take_screenshot, etc. are not separate top-level tools; they only exist as entries inside this "steps" array. For a single screenshot or page read, take_screenshot / get_rendered_page are simpler.' }],
      status: 'error',
    }
  }
  if (rawSteps.length > MAX_BROWSER_STEPS) {
    return { toolUseId: '', content: [{ text: `Too many steps: ${rawSteps.length} > ${MAX_BROWSER_STEPS}` }], status: 'error' }
  }

  const allowed = new Set<string>(ALLOWED_BROWSER_TOOLS)
  const steps: BrowserStep[] = []
  for (const s of rawSteps) {
    if (typeof s.tool !== 'string' || !allowed.has(s.tool)) {
      return {
        toolUseId: '',
        content: [{ text: `Unknown step tool "${String(s.tool)}". Valid step tools: ${ALLOWED_BROWSER_TOOLS.join(', ')}. These are entries inside browse_web's "steps" array — call browse_web, not the step name directly.` }],
        status: 'error',
      }
    }
    steps.push({ tool: s.tool, params: (s.params ?? {}) as Record<string, unknown> })
  }

  const screenshotCount = steps.filter(s => s.tool === 'browser_take_screenshot').length
  if (screenshotCount > MAX_BROWSER_SCREENSHOTS) {
    return { toolUseId: '', content: [{ text: `Too many screenshots: ${screenshotCount} > ${MAX_BROWSER_SCREENSHOTS}` }], status: 'error' }
  }

  const runBrowserSteps = await getRunBrowserSteps()
  const { results, isError } = await runBrowserSteps(steps)
  const { content, screenshotsFound } = browserResultsToContent(results)

  console.log(JSON.stringify({
    event: 'browser_tool',
    tool: 'browse_web',
    result: isError ? 'error' : 'success',
    stepCount: steps.length,
    screenshotCount: screenshotsFound,
    chatId: ctx.chatId,
  }))

  return { toolUseId: '', content, status: isError ? 'error' : 'success' }
}

async function executeTakeScreenshotTool(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResultBlock> {
  const url = typeof input.url === 'string' ? input.url : ''
  if (!url) return { toolUseId: '', content: [{ text: 'Missing required field: url' }], status: 'error' }
  const format = input.format === 'jpeg' ? 'jpeg' : 'png'
  const fullPage = input.fullPage !== false

  const steps: BrowserStep[] = [
    ...resizeSteps(input.width, input.height),
    { tool: 'browser_navigate', params: { url } },
    { tool: 'browser_take_screenshot', params: { type: format, fullPage } },
  ]

  const runBrowserSteps = await getRunBrowserSteps()
  const { results, isError } = await runBrowserSteps(steps)
  const { content, screenshotsFound } = browserResultsToContent(results)

  console.log(JSON.stringify({
    event: 'browser_tool', tool: 'take_screenshot', result: isError ? 'error' : 'success',
    screenshotCount: screenshotsFound, chatId: ctx.chatId,
  }))

  return { toolUseId: '', content, status: isError ? 'error' : 'success' }
}

async function executeGetRenderedPageTool(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResultBlock> {
  const url = typeof input.url === 'string' ? input.url : ''
  if (!url) return { toolUseId: '', content: [{ text: 'Missing required field: url' }], status: 'error' }

  const steps: BrowserStep[] = [
    ...resizeSteps(input.width, input.height),
    { tool: 'browser_navigate', params: { url } },
    { tool: 'browser_snapshot', params: {} },
  ]

  const runBrowserSteps = await getRunBrowserSteps()
  const { results, isError } = await runBrowserSteps(steps)

  if (isError) {
    const { content, screenshotsFound } = browserResultsToContent(results)
    console.log(JSON.stringify({ event: 'browser_tool', tool: 'get_rendered_page', result: 'error', screenshotCount: screenshotsFound, chatId: ctx.chatId }))
    return { toolUseId: '', content, status: 'error' }
  }

  // The navigate step's own response is pure noise here: a code echo, a console-error count,
  // and a "Snapshot" link pointing at a file under this Lambda's ephemeral /tmp — nobody (not
  // the model, not the human) can ever read that path. The explicit browser_snapshot step
  // that follows already repeats Page URL/Title and additionally inlines the real YAML
  // (an unfilenamed browser_snapshot call always inlines — see @playwright/mcp's snapshot
  // tool), so use ONLY its text. Same JSON envelope shape as web_fetch's jinaFetch() —
  // reuses the frontend's existing SearchResultCard rendering path (lib/toolResults.ts),
  // rather than duplicating a new card just for this tool.
  const snapshotText = results[results.length - 1]?.text.join('\n\n') ?? ''
  const titleMatch = snapshotText.match(/Page Title:\s*(.+)/)
  const urlMatch = snapshotText.match(/Page URL:\s*(.+)/)

  console.log(JSON.stringify({ event: 'browser_tool', tool: 'get_rendered_page', result: 'success', screenshotCount: 0, chatId: ctx.chatId }))

  const envelope = {
    result: {
      title: titleMatch?.[1]?.trim() || url,
      url: urlMatch?.[1]?.trim() || url,
      description: 'Rendered page snapshot (accessibility tree)',
    },
    text: snapshotText,
  }
  return { toolUseId: '', content: [{ text: JSON.stringify(envelope) }], status: 'success' }
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

// Amazon Bedrock AgentCore Web Search — routed through the MCP gateway (see ./agentcore/gateway.ts).
// Mapped into the same { results, text } contract jinaSearch produces so toolResults.ts card
// parsing and the SearchResult shape work unchanged regardless of provider.
interface AgentCoreSearchResult {
  text: string
  url?: string
  title?: string
  publishedDate?: string
}

async function agentcoreSearch(query: string): Promise<string> {
  const res = await callGatewayTool('WebSearch', { query: query.slice(0, 200), maxResults: 5 })
  if (res.isError) throw new Error(`AgentCore web search failed: ${res.text}`)

  const parsed = JSON.parse(res.text) as { results?: AgentCoreSearchResult[] }
  const results: SearchResult[] = (parsed.results ?? []).map(r => ({
    title: r.title ?? r.url ?? '',
    url: r.url ?? '',
    description: r.text ?? '',
  }))

  if (results.length === 0) return JSON.stringify({ results: [], text: 'No results found.' })

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
