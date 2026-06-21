import { executeTool, MAX_BROWSER_STEPS, MAX_BROWSER_SCREENSHOTS } from '../../src/lib/tools'
import * as memoryLib from '../../src/lib/memory'
import * as projectContextLib from '../../src/lib/projectContext'
import * as gatewayLib from '../../src/lib/agentcore/gateway'
import * as browserLib from '../../src/lib/agentcore/browser'

// Mock both memory tool executors so we can spy on them without real dynamo calls
jest.mock('../../src/lib/memory', () => ({
  ...jest.requireActual('../../src/lib/memory'),
  executeMemoryTool: jest.fn(),
  executeProjectMemoryTool: jest.fn(),
}))

// Mock project context executors
jest.mock('../../src/lib/projectContext', () => ({
  executeProjectReadFileTool: jest.fn(),
  executeProjectReadChatTool: jest.fn(),
}))

// Mock the AgentCore MCP gateway client so web_search:agentcore tests don't open a real session
jest.mock('../../src/lib/agentcore/gateway', () => ({
  callGatewayTool: jest.fn(),
}))

// Mock the AgentCore Browser session executor so browse_web tests don't open a real session
jest.mock('../../src/lib/agentcore/browser', () => ({
  runBrowserSteps: jest.fn(),
}))

const mockExecuteMemoryTool = (memoryLib as jest.Mocked<typeof memoryLib>).executeMemoryTool
const mockExecuteProjectMemoryTool = (memoryLib as jest.Mocked<typeof memoryLib>).executeProjectMemoryTool
const mockExecuteProjectReadFileTool = (projectContextLib as jest.Mocked<typeof projectContextLib>).executeProjectReadFileTool
const mockExecuteProjectReadChatTool = (projectContextLib as jest.Mocked<typeof projectContextLib>).executeProjectReadChatTool
const mockCallGatewayTool = (gatewayLib as jest.Mocked<typeof gatewayLib>).callGatewayTool
const mockRunBrowserSteps = (browserLib as jest.Mocked<typeof browserLib>).runBrowserSteps

const TEST_CTX = { sub: 'test-user' }

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

    const res = await executeTool('web_fetch', { url: 'https://example.com' }, TEST_CTX)
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

    const res = await executeTool('web_fetch', { url: 'https://example.com/long' }, TEST_CTX)
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

    const res = await executeTool('web_fetch', { url: 'https://example.com/notitle' }, TEST_CTX)
    const payload = JSON.parse((res.content?.[0] as { text: string }).text)
    expect(payload.result.title).toBe('https://example.com/notitle')
    expect(payload.result.url).toBe('https://example.com/notitle')
  })

  it('returns error status when fetch fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }) as unknown as typeof fetch

    const res = await executeTool('web_fetch', { url: 'https://example.com/fail' }, TEST_CTX)
    expect(res.status).toBe('error')
  })

  it('falls back to raw url when data is absent', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as unknown as typeof fetch

    const res = await executeTool('web_fetch', { url: 'https://example.com' }, TEST_CTX)
    const payload = JSON.parse((res.content?.[0] as { text: string }).text)
    expect(payload.result.url).toBe('https://example.com')
    expect(payload.result.title).toBe('https://example.com')  // title falls back to url
    expect(payload.text).toBe('')
  })
})

// ── manage_memory dispatch ────────────────────────────────────────────────────

describe('manage_memory dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('dispatches to executeMemoryTool with ctx.sub', async () => {
    mockExecuteMemoryTool.mockResolvedValueOnce({
      toolUseId: '',
      content: [{ text: 'Saved.' }],
      status: 'success',
    })

    const result = await executeTool(
      'manage_memory',
      { operation: 'remember', text: 'I am a developer', category: 'identity' },
      { sub: 'user-1' },
    )

    expect(mockExecuteMemoryTool).toHaveBeenCalledTimes(1)
    expect(mockExecuteMemoryTool).toHaveBeenCalledWith(
      { operation: 'remember', text: 'I am a developer', category: 'identity' },
      { sub: 'user-1' },
    )
    expect(result.status).toBe('success')
  })

  it('security: input.sub is ignored — dynamo key uses ctx.sub', async () => {
    mockExecuteMemoryTool.mockResolvedValueOnce({
      toolUseId: '',
      content: [{ text: 'Saved.' }],
      status: 'success',
    })

    await executeTool(
      'manage_memory',
      { operation: 'remember', text: 'I am a hacker', category: 'identity', sub: 'attacker-sub' },
      { sub: 'real-user' },
    )

    // The ctx passed to executeMemoryTool must use ctx.sub, not input.sub
    const ctxArg = mockExecuteMemoryTool.mock.calls[0][1] as { sub: string }
    expect(ctxArg.sub).toBe('real-user')
  })
})

// ── manage_project_memory dispatch ────────────────────────────────────────────

describe('manage_project_memory dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('dispatches to executeProjectMemoryTool with ctx.projectId', async () => {
    mockExecuteProjectMemoryTool.mockResolvedValueOnce({
      toolUseId: '',
      content: [{ text: 'Saved.' }],
      status: 'success',
    })

    const result = await executeTool(
      'manage_project_memory',
      { operation: 'remember', text: 'Use DynamoDB single-table design', category: 'decision' },
      { sub: 'user-1', projectId: 'proj-abc' },
    )

    expect(mockExecuteProjectMemoryTool).toHaveBeenCalledTimes(1)
    expect(mockExecuteProjectMemoryTool).toHaveBeenCalledWith(
      { operation: 'remember', text: 'Use DynamoDB single-table design', category: 'decision' },
      { projectId: 'proj-abc' },
    )
    expect(result.status).toBe('success')
  })

  it('returns error when ctx.projectId is missing', async () => {
    const result = await executeTool(
      'manage_project_memory',
      { operation: 'remember', text: 'Use DynamoDB single-table design', category: 'decision' },
      { sub: 'user-1' }, // no projectId
    )

    expect(result.status).toBe('error')
    expect((result.content?.[0] as { text: string }).text).toBe('No project context')
    expect(mockExecuteProjectMemoryTool).not.toHaveBeenCalled()
  })

  it('manage_memory still dispatches to executeMemoryTool (not project memory)', async () => {
    mockExecuteMemoryTool.mockResolvedValueOnce({
      toolUseId: '',
      content: [{ text: 'Saved.' }],
      status: 'success',
    })

    await executeTool(
      'manage_memory',
      { operation: 'remember', text: 'I am a developer', category: 'identity' },
      { sub: 'user-1', projectId: 'proj-abc' },
    )

    expect(mockExecuteMemoryTool).toHaveBeenCalledTimes(1)
    expect(mockExecuteProjectMemoryTool).not.toHaveBeenCalled()
  })
})

// ── read_project_file dispatch ────────────────────────────────────────────────

describe('read_project_file dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('dispatches to executeProjectReadFileTool when ctx.projectId set', async () => {
    mockExecuteProjectReadFileTool.mockResolvedValueOnce({
      toolUseId: '',
      content: [{ text: 'File content.' }],
      status: 'success',
    })

    const result = await executeTool(
      'read_project_file',
      { fileId: 'file1', detail: 'summary' },
      { sub: 'user-1', projectId: 'proj-abc' },
    )

    expect(mockExecuteProjectReadFileTool).toHaveBeenCalledTimes(1)
    expect(mockExecuteProjectReadFileTool).toHaveBeenCalledWith(
      { fileId: 'file1', detail: 'summary' },
      { sub: 'user-1', projectId: 'proj-abc' },
    )
    expect(result.status).toBe('success')
  })

  it('returns error when ctx.projectId is missing', async () => {
    const result = await executeTool(
      'read_project_file',
      { fileId: 'file1', detail: 'summary' },
      { sub: 'user-1' }, // no projectId
    )

    expect(result.status).toBe('error')
    expect((result.content?.[0] as { text: string }).text).toBe('No project context')
    expect(mockExecuteProjectReadFileTool).not.toHaveBeenCalled()
  })
})

// ── read_project_chat dispatch ────────────────────────────────────────────────

describe('read_project_chat dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('dispatches to executeProjectReadChatTool when ctx.projectId set', async () => {
    mockExecuteProjectReadChatTool.mockResolvedValueOnce({
      toolUseId: '',
      content: [{ text: 'Chat summary.' }],
      status: 'success',
    })

    const result = await executeTool(
      'read_project_chat',
      { chatId: 'chat2', detail: 'summary' },
      { sub: 'user-1', projectId: 'proj-abc' },
    )

    expect(mockExecuteProjectReadChatTool).toHaveBeenCalledTimes(1)
    expect(mockExecuteProjectReadChatTool).toHaveBeenCalledWith(
      { chatId: 'chat2', detail: 'summary' },
      { sub: 'user-1', projectId: 'proj-abc' },
    )
    expect(result.status).toBe('success')
  })

  it('returns error when ctx.projectId is missing', async () => {
    const result = await executeTool(
      'read_project_chat',
      { chatId: 'chat2', detail: 'summary' },
      { sub: 'user-1' }, // no projectId
    )

    expect(result.status).toBe('error')
    expect((result.content?.[0] as { text: string }).text).toBe('No project context')
    expect(mockExecuteProjectReadChatTool).not.toHaveBeenCalled()
  })
})

// ── web_search provider dispatch ──────────────────────────────────────────────

describe('web_search provider dispatch', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
    jest.clearAllMocks()
  })

  it('defaults to Jina when ctx.webSearchProvider is unset', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ title: 'A', url: 'https://a.com', description: 'desc' }] }),
    }) as unknown as typeof fetch

    const result = await executeTool('web_search', { query: 'hello' }, TEST_CTX)

    expect(global.fetch).toHaveBeenCalled()
    expect(mockCallGatewayTool).not.toHaveBeenCalled()
    expect(result.status).toBe('success')
  })

  it('routes to Jina when ctx.webSearchProvider is "jina"', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ title: 'A', url: 'https://a.com', description: 'desc' }] }),
    }) as unknown as typeof fetch

    await executeTool('web_search', { query: 'hello' }, { ...TEST_CTX, webSearchProvider: 'jina' })

    expect(global.fetch).toHaveBeenCalled()
    expect(mockCallGatewayTool).not.toHaveBeenCalled()
  })

  it('routes to the AgentCore gateway when ctx.webSearchProvider is "agentcore"', async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      isError: false,
      text: JSON.stringify({
        id: 'abc123',
        results: [
          { text: 'Python 3.13 was released in October 2024.', url: 'https://example.com/py313', title: 'Python 3.13', publishedDate: '2024-10-07' },
        ],
      }),
    })

    const result = await executeTool('web_search', { query: 'python release' }, { ...TEST_CTX, webSearchProvider: 'agentcore' })

    expect(mockCallGatewayTool).toHaveBeenCalledWith('WebSearch', { query: 'python release', maxResults: 5 })
    expect(result.status).toBe('success')
    const payload = JSON.parse((result.content?.[0] as { text: string }).text)
    expect(payload.results).toEqual([
      { title: 'Python 3.13', url: 'https://example.com/py313', description: 'Python 3.13 was released in October 2024.' },
    ])
    expect(payload.text).toContain('Python 3.13 was released in October 2024.')
  })

  it('truncates the query to 200 chars before calling AgentCore', async () => {
    mockCallGatewayTool.mockResolvedValueOnce({ isError: false, text: JSON.stringify({ results: [] }) })

    const longQuery = 'x'.repeat(250)
    await executeTool('web_search', { query: longQuery }, { ...TEST_CTX, webSearchProvider: 'agentcore' })

    const calledArgs = mockCallGatewayTool.mock.calls[0][1] as { query: string }
    expect(calledArgs.query.length).toBe(200)
  })

  it('returns error status when AgentCore reports an error', async () => {
    mockCallGatewayTool.mockResolvedValueOnce({ isError: true, text: 'gateway unavailable' })

    const result = await executeTool('web_search', { query: 'hello' }, { ...TEST_CTX, webSearchProvider: 'agentcore' })

    expect(result.status).toBe('error')
  })

  it('returns "No results found." when AgentCore returns an empty results array', async () => {
    mockCallGatewayTool.mockResolvedValueOnce({ isError: false, text: JSON.stringify({ results: [] }) })

    const result = await executeTool('web_search', { query: 'hello' }, { ...TEST_CTX, webSearchProvider: 'agentcore' })

    const payload = JSON.parse((result.content?.[0] as { text: string }).text)
    expect(payload.results).toEqual([])
    expect(payload.text).toBe('No results found.')
  })

  it('web_fetch always uses Jina, even when webSearchProvider is "agentcore"', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { title: 'A', url: 'https://a.com', content: 'body' } }),
    }) as unknown as typeof fetch

    await executeTool('web_fetch', { url: 'https://a.com' }, { ...TEST_CTX, webSearchProvider: 'agentcore' })

    expect(global.fetch).toHaveBeenCalled()
    expect(mockCallGatewayTool).not.toHaveBeenCalled()
  })
})

describe('browse_web dispatch', () => {
  beforeEach(() => {
    mockRunBrowserSteps.mockClear()
  })

  it('dispatches an allowed step list to runBrowserSteps', async () => {
    mockRunBrowserSteps.mockResolvedValueOnce({
      results: [{ tool: 'browser_navigate', ok: true, text: ['Navigated'], images: [] }],
      isError: false,
    })

    const result = await executeTool('browse_web', { steps: [{ tool: 'browser_navigate', params: { url: 'https://example.com' } }] }, TEST_CTX)

    expect(mockRunBrowserSteps).toHaveBeenCalledWith([{ tool: 'browser_navigate', params: { url: 'https://example.com' } }])
    expect(result.status).toBe('success')
    expect(result.content).toEqual([{ text: '### browser_navigate\nNavigated' }])
  })

  it('returns error without calling runBrowserSteps when steps is empty', async () => {
    const result = await executeTool('browse_web', { steps: [] }, TEST_CTX)
    expect(mockRunBrowserSteps).not.toHaveBeenCalled()
    expect(result.status).toBe('error')
  })

  it('returns error without calling runBrowserSteps when steps is missing', async () => {
    const result = await executeTool('browse_web', {}, TEST_CTX)
    expect(mockRunBrowserSteps).not.toHaveBeenCalled()
    expect(result.status).toBe('error')
  })

  it(`returns error without calling runBrowserSteps when over ${MAX_BROWSER_STEPS} steps`, async () => {
    const steps = Array.from({ length: MAX_BROWSER_STEPS + 1 }, () => ({ tool: 'browser_navigate', params: { url: 'https://example.com' } }))
    const result = await executeTool('browse_web', { steps }, TEST_CTX)
    expect(mockRunBrowserSteps).not.toHaveBeenCalled()
    expect(result.status).toBe('error')
  })

  it('returns a self-correcting error without calling runBrowserSteps when a step uses a disallowed tool', async () => {
    const result = await executeTool('browse_web', { steps: [{ tool: 'browser_run_code_unsafe', params: { code: '1' } }] }, TEST_CTX)
    expect(mockRunBrowserSteps).not.toHaveBeenCalled()
    expect(result.status).toBe('error')
    expect((result.content?.[0] as { text: string }).text).toMatch(/Unknown step tool/)
  })

  it('returns a self-correcting error when steps is empty, mentioning the steps array shape', async () => {
    const result = await executeTool('browse_web', { steps: [] }, TEST_CTX)
    expect((result.content?.[0] as { text: string }).text).toMatch(/non-empty "steps" array/)
  })

  it('gives a self-correcting hint when a step tool name is called as a standalone top-level tool', async () => {
    const result = await executeTool('browser_take_screenshot', { target: 'e1' }, TEST_CTX)
    expect(mockRunBrowserSteps).not.toHaveBeenCalled()
    expect(result.status).toBe('error')
    expect((result.content?.[0] as { text: string }).text).toMatch(/not a standalone tool/)
    expect((result.content?.[0] as { text: string }).text).toMatch(/browse_web/)
  })

  it(`returns error without calling runBrowserSteps when over ${MAX_BROWSER_SCREENSHOTS} screenshot steps`, async () => {
    const steps = Array.from({ length: MAX_BROWSER_SCREENSHOTS + 1 }, () => ({ tool: 'browser_take_screenshot', params: {} }))
    const result = await executeTool('browse_web', { steps }, TEST_CTX)
    expect(mockRunBrowserSteps).not.toHaveBeenCalled()
    expect(result.status).toBe('error')
  })

  it('propagates multiple text and image content entries across steps', async () => {
    mockRunBrowserSteps.mockResolvedValueOnce({
      results: [
        { tool: 'browser_snapshot', ok: true, text: ['tree...'], images: [] },
        { tool: 'browser_take_screenshot', ok: true, text: [], images: [{ format: 'png', bytes: Buffer.from('abc') }] },
        { tool: 'browser_console_messages', ok: true, text: ['[log] hi'], images: [] },
      ],
      isError: false,
    })

    const result = await executeTool('browse_web', {
      steps: [
        { tool: 'browser_snapshot', params: {} },
        { tool: 'browser_take_screenshot', params: {} },
        { tool: 'browser_console_messages', params: { level: 'info' } },
      ],
    }, TEST_CTX)

    expect(result.status).toBe('success')
    expect(result.content).toEqual([
      { text: '### browser_snapshot\ntree...' },
      { image: { format: 'png', source: { bytes: Buffer.from('abc') } } },
      { text: '### browser_console_messages\n[log] hi' },
    ])
  })

  it('returns error status and includes the error text when runBrowserSteps reports isError', async () => {
    mockRunBrowserSteps.mockResolvedValueOnce({
      results: [{ tool: 'browser_click', ok: false, text: [], images: [], error: 'selector not found' }],
      isError: true,
    })

    const result = await executeTool('browse_web', { steps: [{ tool: 'browser_click', params: { target: 'e3' } }] }, TEST_CTX)

    expect(result.status).toBe('error')
    expect((result.content?.[0] as { text: string }).text).toMatch(/selector not found/)
  })

  it('logs a browser_tool CloudWatch event with stepCount and screenshotCount', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    mockRunBrowserSteps.mockResolvedValueOnce({
      results: [{ tool: 'browser_take_screenshot', ok: true, text: [], images: [{ format: 'png', bytes: Buffer.from('x') }] }],
      isError: false,
    })

    await executeTool('browse_web', { steps: [{ tool: 'browser_take_screenshot', params: {} }] }, { ...TEST_CTX, chatId: 'c1' })

    const logged = logSpy.mock.calls.map(c => c[0] as string).find(s => s.includes('browser_tool'))
    expect(logged).toBeDefined()
    const parsed = JSON.parse(logged!)
    expect(parsed).toMatchObject({ event: 'browser_tool', result: 'success', stepCount: 1, screenshotCount: 1, chatId: 'c1' })
    logSpy.mockRestore()
  })
})

describe('take_screenshot dispatch', () => {
  beforeEach(() => {
    mockRunBrowserSteps.mockClear()
  })

  it('composes navigate + take_screenshot steps (no resize when width/height omitted)', async () => {
    mockRunBrowserSteps.mockResolvedValueOnce({
      results: [
        { tool: 'browser_navigate', ok: true, text: ['Navigated'], images: [] },
        { tool: 'browser_take_screenshot', ok: true, text: [], images: [{ format: 'png', bytes: Buffer.from('img') }] },
      ],
      isError: false,
    })

    const result = await executeTool('take_screenshot', { url: 'https://example.com' }, TEST_CTX)

    expect(mockRunBrowserSteps).toHaveBeenCalledWith([
      { tool: 'browser_navigate', params: { url: 'https://example.com' } },
      { tool: 'browser_take_screenshot', params: { type: 'png', fullPage: true } },
    ])
    expect(result.status).toBe('success')
    expect(result.content).toEqual([
      { text: '### browser_navigate\nNavigated' },
      { image: { format: 'png', source: { bytes: Buffer.from('img') } } },
    ])
  })

  it('adds a leading resize step when width and height are given, and forwards format/fullPage', async () => {
    mockRunBrowserSteps.mockResolvedValueOnce({ results: [], isError: false })

    await executeTool('take_screenshot', { url: 'https://example.com', width: 1280, height: 800, format: 'jpeg', fullPage: false }, TEST_CTX)

    expect(mockRunBrowserSteps).toHaveBeenCalledWith([
      { tool: 'browser_resize', params: { width: 1280, height: 800 } },
      { tool: 'browser_navigate', params: { url: 'https://example.com' } },
      { tool: 'browser_take_screenshot', params: { type: 'jpeg', fullPage: false } },
    ])
  })

  it('returns error without calling runBrowserSteps when url is missing', async () => {
    const result = await executeTool('take_screenshot', {}, TEST_CTX)
    expect(mockRunBrowserSteps).not.toHaveBeenCalled()
    expect(result.status).toBe('error')
  })

  it('propagates a runBrowserSteps error', async () => {
    mockRunBrowserSteps.mockResolvedValueOnce({
      results: [{ tool: 'browser_navigate', ok: false, text: [], images: [], error: 'net::ERR_NAME_NOT_RESOLVED' }],
      isError: true,
    })
    const result = await executeTool('take_screenshot', { url: 'https://bad.invalid' }, TEST_CTX)
    expect(result.status).toBe('error')
  })
})

describe('get_rendered_page dispatch', () => {
  beforeEach(() => {
    mockRunBrowserSteps.mockClear()
  })

  it('composes navigate + snapshot steps (no resize when width/height omitted)', async () => {
    mockRunBrowserSteps.mockResolvedValueOnce({
      results: [
        // navigate's own auto-attached-snapshot trace is pure noise (code echo + a dead
        // /tmp file link) and must NOT end up in the tool result.
        { tool: 'browser_navigate', ok: true, text: ['### Ran Playwright code\n```js\nawait page.goto(\'https://example.com\');\n```\n### Snapshot\n- [Snapshot](../../tmp/page-x.yml)'], images: [] },
        { tool: 'browser_snapshot', ok: true, text: ['### Page\n- Page URL: https://example.com/\n- Page Title: Example Domain\n### Snapshot\n```yaml\n- heading "Example Domain"\n```'], images: [] },
      ],
      isError: false,
    })

    const result = await executeTool('get_rendered_page', { url: 'https://example.com' }, TEST_CTX)

    expect(mockRunBrowserSteps).toHaveBeenCalledWith([
      { tool: 'browser_navigate', params: { url: 'https://example.com' } },
      { tool: 'browser_snapshot', params: {} },
    ])
    expect(result.status).toBe('success')
    expect(result.content).toHaveLength(1)
    const envelope = JSON.parse((result.content![0] as { text: string }).text) as { result: { title: string; url: string; description: string }; text: string }
    // Same {result,text} shape web_fetch's jinaFetch() produces — reuses its card rendering.
    expect(envelope.result.title).toBe('Example Domain')
    expect(envelope.result.url).toBe('https://example.com/')
    expect(envelope.text).toContain('heading "Example Domain"')
    expect(envelope.text).not.toContain('Ran Playwright code')
    expect(envelope.text).not.toContain('/tmp/')
  })

  it('falls back to the input url when Page Title/URL cannot be parsed from the snapshot text', async () => {
    mockRunBrowserSteps.mockResolvedValueOnce({
      results: [
        { tool: 'browser_navigate', ok: true, text: ['nav trace'], images: [] },
        { tool: 'browser_snapshot', ok: true, text: ['- [Snapshot]'], images: [] },
      ],
      isError: false,
    })

    const result = await executeTool('get_rendered_page', { url: 'https://example.com' }, TEST_CTX)
    const envelope = JSON.parse((result.content![0] as { text: string }).text) as { result: { title: string; url: string } }
    expect(envelope.result.title).toBe('https://example.com')
    expect(envelope.result.url).toBe('https://example.com')
  })

  it('adds a leading resize step when width and height are given', async () => {
    mockRunBrowserSteps.mockResolvedValueOnce({ results: [], isError: false })

    await executeTool('get_rendered_page', { url: 'https://example.com', width: 1024, height: 768 }, TEST_CTX)

    expect(mockRunBrowserSteps).toHaveBeenCalledWith([
      { tool: 'browser_resize', params: { width: 1024, height: 768 } },
      { tool: 'browser_navigate', params: { url: 'https://example.com' } },
      { tool: 'browser_snapshot', params: {} },
    ])
  })

  it('returns error without calling runBrowserSteps when url is missing', async () => {
    const result = await executeTool('get_rendered_page', {}, TEST_CTX)
    expect(mockRunBrowserSteps).not.toHaveBeenCalled()
    expect(result.status).toBe('error')
  })

  it('returns the generic multi-step error content (not a JSON envelope) when a step fails', async () => {
    mockRunBrowserSteps.mockResolvedValueOnce({
      results: [{ tool: 'browser_navigate', ok: false, text: [], images: [], error: 'net::ERR_NAME_NOT_RESOLVED' }],
      isError: true,
    })

    const result = await executeTool('get_rendered_page', { url: 'https://bad.invalid' }, TEST_CTX)
    expect(result.status).toBe('error')
    expect((result.content?.[0] as { text: string }).text).toMatch(/ERR_NAME_NOT_RESOLVED/)
  })
})
