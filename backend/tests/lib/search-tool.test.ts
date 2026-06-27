import { buildSearchHistoryCorpus, executeSearchHistoryTool } from '../../src/lib/search'
import * as dynamo from '../../src/lib/dynamo'
import * as bedrock from '../../src/lib/bedrock'

jest.mock('../../src/lib/dynamo', () => ({
  ...jest.requireActual('../../src/lib/dynamo'),
  listChats: jest.fn(),
  listProjectFiles: jest.fn(),
  listProjects: jest.fn(),
}))
jest.mock('../../src/lib/bedrock')

const mockDynamo = dynamo as jest.Mocked<typeof dynamo>
const mockBedrock = bedrock as jest.Mocked<typeof bedrock>

beforeEach(() => jest.clearAllMocks())

// ── buildSearchHistoryCorpus ────────────────────────────────────────────────────────────

describe('buildSearchHistoryCorpus', () => {
  test('project scope — includes only chats in that project, skips chats with no summary, includes ready files newest-first', async () => {
    mockDynamo.listChats.mockResolvedValue([
      { SK: 'CHAT#chat-1', title: 'In project, summarized', summary: 'Discussed X', topics: ['X'], projectId: 'proj-1' },
      { SK: 'CHAT#chat-2', title: 'In project, no summary yet', projectId: 'proj-1' },
      { SK: 'CHAT#chat-3', title: 'Different project', summary: 'Discussed Y', projectId: 'proj-2' },
    ])
    mockDynamo.listProjectFiles.mockResolvedValue([
      { fileId: 'file-old', filename: 'old.md', status: 'ready', summary: 'Old file' },
      { fileId: 'file-new', filename: 'new.md', status: 'ready', summary: 'New file' },
      { fileId: 'file-pending', filename: 'pending.md', status: 'processing' },
    ])

    const corpus = await buildSearchHistoryCorpus('user-1', 'project', 'proj-1')

    expect(corpus).toEqual([
      { kind: 'chat', id: 'chat-1', title: 'In project, summarized', topics: ['X'], summary: 'Discussed X', projectId: 'proj-1' },
      { kind: 'file', id: 'file-new', title: 'new.md', summary: 'New file', projectId: 'proj-1' },
      { kind: 'file', id: 'file-old', title: 'old.md', summary: 'Old file', projectId: 'proj-1' },
    ])
    expect(mockDynamo.listProjectFiles).toHaveBeenCalledWith('proj-1')
    expect(mockDynamo.listProjects).not.toHaveBeenCalled()
  })

  test('project scope — file with only a microLabel (no summary) still included, using microLabel as its summary', async () => {
    mockDynamo.listChats.mockResolvedValue([])
    mockDynamo.listProjectFiles.mockResolvedValue([
      { fileId: 'file-1', filename: 'notes.txt', status: 'ready', microLabel: 'Quick notes' },
    ])

    const corpus = await buildSearchHistoryCorpus('user-1', 'project', 'proj-1')
    expect(corpus).toEqual([
      { kind: 'file', id: 'file-1', title: 'notes.txt', summary: 'Quick notes', projectId: 'proj-1' },
    ])
  })

  test('global scope — includes all of the user\'s chats regardless of project, plus a sweep of project files', async () => {
    mockDynamo.listChats.mockResolvedValue([
      { SK: 'CHAT#chat-1', title: 'No project', summary: 'About A' },
      { SK: 'CHAT#chat-2', title: 'In a project', summary: 'About B', projectId: 'proj-1' },
    ])
    mockDynamo.listProjects.mockResolvedValue([
      { SK: 'PROJECT#proj-1', name: 'Project One' },
    ])
    mockDynamo.listProjectFiles.mockResolvedValue([
      { fileId: 'file-1', filename: 'design.md', status: 'ready', summary: 'Design notes' },
    ])

    const corpus = await buildSearchHistoryCorpus('user-1', 'global')

    expect(corpus).toEqual([
      { kind: 'chat', id: 'chat-1', title: 'No project', summary: 'About A' },
      { kind: 'chat', id: 'chat-2', title: 'In a project', summary: 'About B', projectId: 'proj-1' },
      { kind: 'file', id: 'file-1', title: 'design.md', summary: 'Design notes', projectId: 'proj-1' },
    ])
  })

  test('global scope — caps the project file sweep to SEARCH_HISTORY_PROJECT_SWEEP_CAP projects', async () => {
    const manyProjects = Array.from({ length: 30 }, (_, i) => ({ SK: `PROJECT#proj-${i}` }))
    mockDynamo.listChats.mockResolvedValue([])
    mockDynamo.listProjects.mockResolvedValue(manyProjects)
    mockDynamo.listProjectFiles.mockResolvedValue([])

    await buildSearchHistoryCorpus('user-1', 'global')

    // SEARCH_HISTORY_PROJECT_SWEEP_CAP = 20 per lib/search.ts
    expect(mockDynamo.listProjectFiles).toHaveBeenCalledTimes(20)
  })

  test('project scope with no projectId falls back to global behaviour', async () => {
    mockDynamo.listChats.mockResolvedValue([
      { SK: 'CHAT#chat-1', title: 'Some chat', summary: 'About A' },
    ])
    mockDynamo.listProjects.mockResolvedValue([])

    const corpus = await buildSearchHistoryCorpus('user-1', 'project', undefined)
    expect(corpus).toEqual([{ kind: 'chat', id: 'chat-1', title: 'Some chat', summary: 'About A' }])
    expect(mockDynamo.listProjects).toHaveBeenCalled() // fell through to the global branch
  })
})

// ── executeSearchHistoryTool ───────────────────────────────────────────────────
//
// These exercise the real searchHistory (only Bedrock + dynamo are mocked) — jest.spyOn on a
// same-module export does NOT intercept internal calls (TS compiles them as direct references
// to the local function declaration, not through the exports object), so a true integration
// through searchHistory is both correct and the only option here.

describe('executeSearchHistoryTool', () => {
  test('returns an error without touching dynamo when query is missing', async () => {
    const result = await executeSearchHistoryTool({}, { sub: 'user-1' })
    expect(result.status).toBe('error')
    expect(mockDynamo.listChats).not.toHaveBeenCalled()
  })

  test('returns an error without touching dynamo when query is blank', async () => {
    const result = await executeSearchHistoryTool({ query: '   ' }, { sub: 'user-1' })
    expect(result.status).toBe('error')
    expect(mockDynamo.listChats).not.toHaveBeenCalled()
  })

  test('ctx.searchScope overrides a model-supplied scope (forced Search turn uses global despite scope:"project")', async () => {
    mockDynamo.listChats.mockResolvedValue([])
    mockDynamo.listProjects.mockResolvedValue([])
    mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ results: [] }))

    await executeSearchHistoryTool({ query: 'athena', scope: 'project' }, { sub: 'user-1', projectId: 'proj-1', searchScope: 'global' })

    // Global scope sweeps listProjects(); project scope never calls it. Proves ctx.searchScope won.
    expect(mockDynamo.listProjects).toHaveBeenCalled()
  })

  test('falls back to model-supplied scope when ctx.searchScope is unset (organic call honours scope:"project")', async () => {
    mockDynamo.listChats.mockResolvedValue([])
    mockDynamo.listProjectFiles.mockResolvedValue([])
    mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ results: [] }))

    await executeSearchHistoryTool({ query: 'athena', scope: 'project' }, { sub: 'user-1', projectId: 'proj-1' })

    expect(mockDynamo.listProjectFiles).toHaveBeenCalledWith('proj-1')
    expect(mockDynamo.listProjects).not.toHaveBeenCalled()
  })

  test('defaults to project scope when in a project and no scope given, else global', async () => {
    mockDynamo.listChats.mockResolvedValue([])
    mockDynamo.listProjectFiles.mockResolvedValue([])
    mockDynamo.listProjects.mockResolvedValue([])
    mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ results: [] }))

    await executeSearchHistoryTool({ query: 'athena' }, { sub: 'user-1', projectId: 'proj-1' })
    expect(mockDynamo.listProjectFiles).toHaveBeenCalledWith('proj-1')
    expect(mockDynamo.listProjects).not.toHaveBeenCalled()

    jest.clearAllMocks()
    mockDynamo.listChats.mockResolvedValue([])
    mockDynamo.listProjects.mockResolvedValue([])
    mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ results: [] }))

    await executeSearchHistoryTool({ query: 'athena' }, { sub: 'user-1' })
    expect(mockDynamo.listProjects).toHaveBeenCalled() // global sweep — no project to scope to
  })

  test('success envelope contains both results (for cards) and a human-readable text summary', async () => {
    mockDynamo.listChats.mockResolvedValue([
      { SK: 'CHAT#chat-1', title: 'Athena tuning', summary: 'Cost tuning notes' },
    ])
    mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
      results: [{ id: 'chat:chat-1', reason: 'Matches query' }],
    }))

    const result = await executeSearchHistoryTool({ query: 'athena' }, { sub: 'user-1' })
    expect(result.status).toBe('success')
    const payload = JSON.parse((result.content?.[0] as { text: string }).text) as { results: unknown[]; text: string }
    expect(payload.results).toEqual([{ kind: 'chat', id: 'chat-1', title: 'Athena tuning', reason: 'Matches query' }])
    expect(payload.text).toContain('Athena tuning')
    expect(payload.text).toContain('Matches query')
  })

  test('"No relevant past chats or files found." when nothing matches', async () => {
    mockDynamo.listChats.mockResolvedValue([])
    mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({ results: [] }))

    const result = await executeSearchHistoryTool({ query: 'athena' }, { sub: 'user-1' })
    const payload = JSON.parse((result.content?.[0] as { text: string }).text) as { results: unknown[]; text: string }
    expect(payload.results).toEqual([])
    expect(payload.text).toBe('No relevant past chats or files found.')
  })
})
