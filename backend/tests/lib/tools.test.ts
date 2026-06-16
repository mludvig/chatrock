import { executeTool } from '../../src/lib/tools'
import * as memoryLib from '../../src/lib/memory'
import * as projectContextLib from '../../src/lib/projectContext'

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

const mockExecuteMemoryTool = (memoryLib as jest.Mocked<typeof memoryLib>).executeMemoryTool
const mockExecuteProjectMemoryTool = (memoryLib as jest.Mocked<typeof memoryLib>).executeProjectMemoryTool
const mockExecuteProjectReadFileTool = (projectContextLib as jest.Mocked<typeof projectContextLib>).executeProjectReadFileTool
const mockExecuteProjectReadChatTool = (projectContextLib as jest.Mocked<typeof projectContextLib>).executeProjectReadChatTool

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
