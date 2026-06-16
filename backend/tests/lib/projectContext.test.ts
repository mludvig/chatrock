import { executeProjectReadFileTool, executeProjectReadChatTool } from '../../src/lib/projectContext'
import * as dynamo from '../../src/lib/dynamo'
import * as projectFilesLib from '../../src/lib/projectFiles'
import * as blocksLib from '../../src/lib/blocks'
import * as treeLib from '../../src/lib/tree'

jest.mock('../../src/lib/dynamo', () => ({
  getProjectFile: jest.fn(),
  getChat: jest.fn(),
  listMessages: jest.fn(),
  listChats: jest.fn(),
}))

jest.mock('../../src/lib/projectFiles', () => ({
  fetchS3Text: jest.fn(),
  fetchS3Bytes: jest.fn(),
}))

jest.mock('../../src/lib/blocks', () => ({
  capToolResultText: (t: string) => t,
  TOOL_RESULT_CAP: 30000,
}))

jest.mock('../../src/lib/tree', () => ({
  buildActivePath: jest.fn(),
}))

const mockGetProjectFile = dynamo.getProjectFile as jest.MockedFunction<typeof dynamo.getProjectFile>
const mockGetChat = dynamo.getChat as jest.MockedFunction<typeof dynamo.getChat>
const mockListMessages = dynamo.listMessages as jest.MockedFunction<typeof dynamo.listMessages>
const mockFetchS3Text = projectFilesLib.fetchS3Text as jest.MockedFunction<typeof projectFilesLib.fetchS3Text>
const mockFetchS3Bytes = projectFilesLib.fetchS3Bytes as jest.MockedFunction<typeof projectFilesLib.fetchS3Bytes>
const mockBuildActivePath = treeLib.buildActivePath as jest.MockedFunction<typeof treeLib.buildActivePath>

// Silence unused import warning for blocksLib
void blocksLib

const ctx = { sub: 'user1', projectId: 'proj1', chatId: 'chat-current' }

// Helper to get content array safely
function content0(result: { content?: unknown[] }) {
  return result.content![0]
}

describe('executeProjectReadFileTool', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns summary when detail=summary', async () => {
    mockGetProjectFile.mockResolvedValue({
      fileId: 'f1', filename: 'notes.txt',
      microLabel: 'Meeting notes', summary: 'Covers Q3 planning.',
      contentType: 'text/plain', s3Key: 'att/user1/project/proj1/f1/notes.txt',
      status: 'ready', inclusion: 'auto',
    } as Record<string, unknown>)
    const result = await executeProjectReadFileTool({ fileId: 'f1', detail: 'summary' }, ctx)
    expect(result.status).toBe('success')
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('Meeting notes') })
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('Covers Q3 planning.') })
  })

  it('returns full text when detail=full for text file', async () => {
    mockGetProjectFile.mockResolvedValue({
      fileId: 'f1', filename: 'notes.txt', microLabel: 'M', summary: 'S',
      contentType: 'text/plain', s3Key: 'k/notes.txt', status: 'ready', inclusion: 'auto',
    } as Record<string, unknown>)
    mockFetchS3Text.mockResolvedValue('Full file content here')
    const result = await executeProjectReadFileTool({ fileId: 'f1', detail: 'full' }, ctx)
    expect(result.status).toBe('success')
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('Full file content here') })
  })

  it('uses extractedTextKey sidecar when available for text files', async () => {
    mockGetProjectFile.mockResolvedValue({
      fileId: 'f1', filename: 'notes.txt', microLabel: 'M', summary: 'S',
      contentType: 'text/plain', s3Key: 'k/notes.txt',
      extractedTextKey: 'k/notes.txt.extracted.txt',
      status: 'ready', inclusion: 'auto',
    } as Record<string, unknown>)
    mockFetchS3Text.mockResolvedValue('Extracted text')
    const result = await executeProjectReadFileTool({ fileId: 'f1', detail: 'full' }, ctx)
    expect(result.status).toBe('success')
    expect(mockFetchS3Text).toHaveBeenCalledWith('k/notes.txt.extracted.txt')
  })

  it('returns pdf summary with note when no extractedTextKey', async () => {
    mockGetProjectFile.mockResolvedValue({
      fileId: 'f2', filename: 'report.pdf', microLabel: 'Report', summary: 'Annual report.',
      contentType: 'application/pdf', s3Key: 'k/report.pdf',
      status: 'ready', inclusion: 'auto',
    } as Record<string, unknown>)
    const result = await executeProjectReadFileTool({ fileId: 'f2', detail: 'full' }, ctx)
    expect(result.status).toBe('success')
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('Annual report.') })
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('Full text not available') })
  })

  it('returns pdf full text when extractedTextKey exists', async () => {
    mockGetProjectFile.mockResolvedValue({
      fileId: 'f2', filename: 'report.pdf', microLabel: 'Report', summary: 'Annual report.',
      contentType: 'application/pdf', s3Key: 'k/report.pdf',
      extractedTextKey: 'k/report.pdf.extracted.txt',
      status: 'ready', inclusion: 'auto',
    } as Record<string, unknown>)
    mockFetchS3Text.mockResolvedValue('PDF extracted text content')
    const result = await executeProjectReadFileTool({ fileId: 'f2', detail: 'full' }, ctx)
    expect(result.status).toBe('success')
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('PDF extracted text content') })
  })

  it('returns image bytes block when detail=full for image file', async () => {
    const fakeBytes = new Uint8Array([1, 2, 3])
    mockGetProjectFile.mockResolvedValue({
      fileId: 'f3', filename: 'photo.png', microLabel: 'Photo', summary: 'A diagram.',
      contentType: 'image/png', s3Key: 'k/photo.png',
      status: 'ready', inclusion: 'auto',
    } as Record<string, unknown>)
    mockFetchS3Bytes.mockResolvedValue(fakeBytes)
    const result = await executeProjectReadFileTool({ fileId: 'f3', detail: 'full' }, ctx)
    expect(result.status).toBe('success')
    // Image content block is returned (not a text block)
    expect(content0(result)).toMatchObject({ image: { format: 'png', source: { bytes: fakeBytes } } })
  })

  it('returns error when file not in project', async () => {
    mockGetProjectFile.mockResolvedValue(undefined)
    const result = await executeProjectReadFileTool({ fileId: 'bad', detail: 'summary' }, ctx)
    expect(result.status).toBe('error')
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('not found') })
  })

  it('returns error when no projectId in ctx', async () => {
    const result = await executeProjectReadFileTool({ fileId: 'f1', detail: 'summary' }, { sub: 'u' })
    expect(result.status).toBe('error')
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('Missing') })
  })

  it('returns error for unknown detail level', async () => {
    mockGetProjectFile.mockResolvedValue({
      fileId: 'f1', filename: 'notes.txt', microLabel: 'M', summary: 'S',
      contentType: 'text/plain', s3Key: 'k/notes.txt', status: 'ready', inclusion: 'auto',
    } as Record<string, unknown>)
    const result = await executeProjectReadFileTool({ fileId: 'f1', detail: 'unknown' }, ctx)
    expect(result.status).toBe('error')
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('Unknown detail level') })
  })
})

describe('executeProjectReadChatTool', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns summary of a sibling chat', async () => {
    mockGetChat.mockResolvedValue({
      title: 'Sibling Chat', projectId: 'proj1', summary: 'Chat about APIs.',
    } as Record<string, unknown>)
    const result = await executeProjectReadChatTool({ chatId: 'chat2', detail: 'summary' }, ctx)
    expect(result.status).toBe('success')
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('Chat about APIs.') })
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('Sibling Chat') })
  })

  it('uses (no summary yet) when chat has no summary', async () => {
    mockGetChat.mockResolvedValue({
      title: 'No Summary Chat', projectId: 'proj1',
    } as Record<string, unknown>)
    const result = await executeProjectReadChatTool({ chatId: 'chat2', detail: 'summary' }, ctx)
    expect(result.status).toBe('success')
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('(no summary yet)') })
  })

  it('rejects reading the current chat', async () => {
    const result = await executeProjectReadChatTool({ chatId: 'chat-current', detail: 'summary' }, ctx)
    expect(result.status).toBe('error')
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('current chat') })
  })

  it('rejects chat from a different project', async () => {
    mockGetChat.mockResolvedValue({ title: 'Other', projectId: 'other-proj' } as Record<string, unknown>)
    const result = await executeProjectReadChatTool({ chatId: 'chat-other', detail: 'summary' }, ctx)
    expect(result.status).toBe('error')
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('not found') })
  })

  it('rejects chat not found (null)', async () => {
    mockGetChat.mockResolvedValue(undefined)
    const result = await executeProjectReadChatTool({ chatId: 'chat-missing', detail: 'summary' }, ctx)
    expect(result.status).toBe('error')
  })

  it('returns full transcript', async () => {
    mockGetChat.mockResolvedValue({ title: 'Chat 2', projectId: 'proj1' } as Record<string, unknown>)
    const rows = [
      { msgId: 'm1', parentId: null, role: 'user', blocks: [{ text: 'Hello' }] },
      { msgId: 'm2', parentId: 'm1', role: 'assistant', blocks: [{ text: 'Hi there' }] },
    ]
    mockListMessages.mockResolvedValue(rows as Record<string, unknown>[])
    mockBuildActivePath.mockReturnValue(rows as unknown as import('../../src/lib/tree').TurnRow[])
    const result = await executeProjectReadChatTool({ chatId: 'chat2', detail: 'full' }, ctx)
    expect(result.status).toBe('success')
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('Hello') })
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('Hi there') })
  })

  it('returns empty message when chat has no messages', async () => {
    mockGetChat.mockResolvedValue({ title: 'Empty Chat', projectId: 'proj1' } as Record<string, unknown>)
    mockListMessages.mockResolvedValue([])
    const result = await executeProjectReadChatTool({ chatId: 'chat2', detail: 'full' }, ctx)
    expect(result.status).toBe('success')
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('no messages') })
  })

  it('returns error when no projectId in ctx', async () => {
    const result = await executeProjectReadChatTool({ chatId: 'chat2', detail: 'summary' }, { sub: 'u' })
    expect(result.status).toBe('error')
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('Missing') })
  })

  it('returns error for unknown detail level', async () => {
    mockGetChat.mockResolvedValue({ title: 'Chat 2', projectId: 'proj1' } as Record<string, unknown>)
    const result = await executeProjectReadChatTool({ chatId: 'chat2', detail: 'unknown' }, ctx)
    expect(result.status).toBe('error')
    expect(content0(result)).toMatchObject({ text: expect.stringContaining('Unknown detail level') })
  })
})
