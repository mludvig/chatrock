import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { handler } from '../../src/http/projects'
import * as dynamo from '../../src/lib/dynamo'
import * as attachments from '../../src/lib/attachments'
import * as projectFiles from '../../src/lib/projectFiles'

// Auto-mock the whole dynamo module so all exports (including `ddb`) are mocked
jest.mock('../../src/lib/dynamo')
// Mock attachments (deleteProjectObjects, presignPut, validateAttachment, projectFilePrefix)
jest.mock('../../src/lib/attachments')
// Mock projectFiles (summarizeFile)
jest.mock('../../src/lib/projectFiles')


const mockDynamo = dynamo as jest.Mocked<typeof dynamo>
const mockAttachments = attachments as jest.Mocked<typeof attachments>
const mockProjectFiles = projectFiles as jest.Mocked<typeof projectFiles>

// The DELETE handler calls ddb.send(new QueryCommand(...)) directly.
// Since jest.mock automocks the module, `ddb` is a plain object whose methods
// are NOT automatically jest.fn(). We cast it and set up send manually.
const mockDdbSend = jest.fn()
;(mockDynamo.ddb as unknown as { send: jest.Mock }).send = mockDdbSend

const makeEvent = (
  method: string,
  path: string,
  body?: object,
  pathParams?: Record<string, string>,
) => ({
  requestContext: {
    authorizer: { jwt: { claims: { sub: 'user-1' } } },
  },
  routeKey: `${method} ${path}`,
  pathParameters: pathParams ?? {},
  body: body ? JSON.stringify(body) : undefined,
})

const result = (r: unknown) => r as APIGatewayProxyStructuredResultV2

beforeEach(() => {
  jest.clearAllMocks()
  // Reset ddb.send mock (clearAllMocks resets call counts but preserves the reference)
  mockDdbSend.mockResolvedValue({ Items: [] })
  // Default attachments mocks
  mockAttachments.deleteProjectObjects.mockResolvedValue(undefined)
  mockAttachments.deleteS3Objects.mockResolvedValue(undefined)
  mockAttachments.validateAttachment.mockReturnValue({ kind: 'document', format: 'pdf', maxBytes: 25 * 1024 * 1024 })
  mockAttachments.presignPut.mockResolvedValue('https://s3.example.com/upload-url')
  mockAttachments.projectFilePrefix.mockReturnValue('attachments/user-1/project/proj-1/')
})

// ── GET /api/projects ─────────────────────────────────────────────────────────

test('GET /api/projects returns empty list when no projects', async () => {
  mockDynamo.listProjects.mockResolvedValue([])
  const res = result(await handler(makeEvent('GET', '/api/projects') as any))
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body ?? '{}')
  expect(body.projects).toEqual([])
})

test('GET /api/projects returns mapped list with SK stripped of PROJECT#', async () => {
  mockDynamo.listProjects.mockResolvedValue([
    {
      PK: 'USER#user-1', SK: 'PROJECT#proj-abc',
      name: 'Alpha', description: 'Desc A', instructions: 'Inst A',
      memoryEnabled: true, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    },
    {
      PK: 'USER#user-1', SK: 'PROJECT#proj-xyz',
      name: 'Beta', description: '', instructions: '',
      memoryEnabled: false, createdAt: '2025-01-02T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z',
    },
  ])
  const res = result(await handler(makeEvent('GET', '/api/projects') as any))
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body ?? '{}')
  expect(body.projects).toHaveLength(2)
  expect(body.projects[0].projectId).toBe('proj-abc')
  expect(body.projects[0].name).toBe('Alpha')
  expect(body.projects[0].description).toBe('Desc A')
  expect(body.projects[0].memoryEnabled).toBe(true)
  expect(body.projects[1].projectId).toBe('proj-xyz')
  expect(body.projects[1].memoryEnabled).toBe(false)
  // SK must not appear directly in the output
  for (const p of body.projects) {
    expect(p.SK).toBeUndefined()
    expect(p.PK).toBeUndefined()
  }
})

// ── POST /api/projects ────────────────────────────────────────────────────────

test('POST /api/projects creates with uuid, defaults (description:"", instructions:"", memoryEnabled:true), 201', async () => {
  mockDynamo.buildProjectKey.mockReturnValue({ PK: 'USER#user-1', SK: 'PROJECT#new-id' })
  mockDynamo.putProject.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('POST', '/api/projects', { name: 'My Project' }) as any))
  expect(res.statusCode).toBe(201)
  const body = JSON.parse(res.body ?? '{}')
  expect(typeof body.projectId).toBe('string')
  expect(body.projectId.length).toBeGreaterThan(0)
  expect(mockDynamo.putProject).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'My Project',
      description: '',
      instructions: '',
      memoryEnabled: true,
    }),
  )
})

test('POST /api/projects rejects missing name → 400', async () => {
  const res = result(await handler(makeEvent('POST', '/api/projects', {}) as any))
  expect(res.statusCode).toBe(400)
  expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: expect.stringContaining('name') })
})

test('POST /api/projects rejects empty name → 400', async () => {
  const res = result(await handler(makeEvent('POST', '/api/projects', { name: '   ' }) as any))
  expect(res.statusCode).toBe(400)
})

test('POST /api/projects accepts optional description, instructions, memoryEnabled fields', async () => {
  mockDynamo.buildProjectKey.mockReturnValue({ PK: 'USER#user-1', SK: 'PROJECT#new-id' })
  mockDynamo.putProject.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('POST', '/api/projects', {
    name: 'Full Project',
    description: 'Some description',
    instructions: 'Do X, then Y',
    memoryEnabled: false,
  }) as any))
  expect(res.statusCode).toBe(201)
  expect(mockDynamo.putProject).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'Full Project',
      description: 'Some description',
      instructions: 'Do X, then Y',
      memoryEnabled: false,
    }),
  )
})

test('POST /api/projects with non-JSON body → 400', async () => {
  const event = {
    requestContext: { authorizer: { jwt: { claims: { sub: 'user-1' } } } },
    routeKey: 'POST /api/projects',
    pathParameters: {},
    body: 'not json',
  }
  const res = result(await handler(event as any))
  expect(res.statusCode).toBe(400)
})

// ── GET /api/projects/{projectId} ─────────────────────────────────────────────

test('GET /api/projects/{projectId} returns project + filtered chats list', async () => {
  mockDynamo.getProject.mockResolvedValue({
    PK: 'USER#user-1', SK: 'PROJECT#proj-1',
    name: 'P1', description: 'D', instructions: 'I',
    memoryEnabled: true, createdAt: 'ca', updatedAt: 'ua',
  })
  mockDynamo.listChats.mockResolvedValue([
    { PK: 'USER#user-1', SK: 'CHAT#c1', title: 'Chat 1', model: 'x', systemPrompt: '', createdAt: 'ca', updatedAt: 'ua', projectId: 'proj-1' },
    { PK: 'USER#user-1', SK: 'CHAT#c2', title: 'Chat 2', model: 'x', systemPrompt: '', createdAt: 'ca', updatedAt: 'ua', projectId: 'proj-other' },
    { PK: 'USER#user-1', SK: 'CHAT#c3', title: 'Chat 3', model: 'x', systemPrompt: '', createdAt: 'ca', updatedAt: 'ua' },
  ])
  const res = result(await handler(makeEvent('GET', '/api/projects/{projectId}', undefined, { projectId: 'proj-1' }) as any))
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body ?? '{}')
  expect(body.project.projectId).toBe('proj-1')
  expect(body.project.name).toBe('P1')
  // Only c1 belongs to proj-1
  expect(body.chats).toHaveLength(1)
  expect(body.chats[0].chatId).toBe('c1')
})

test('GET /api/projects/{projectId} returns 404 when project not found', async () => {
  mockDynamo.getProject.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('GET', '/api/projects/{projectId}', undefined, { projectId: 'no-such' }) as any))
  expect(res.statusCode).toBe(404)
})

test('GET /api/projects/{projectId} chats list is empty when no chats have this projectId', async () => {
  mockDynamo.getProject.mockResolvedValue({
    PK: 'USER#user-1', SK: 'PROJECT#proj-1',
    name: 'P1', description: '', instructions: '',
    memoryEnabled: true, createdAt: '', updatedAt: '',
  })
  mockDynamo.listChats.mockResolvedValue([
    { PK: 'USER#user-1', SK: 'CHAT#c1', title: 'Chat 1', model: 'x', systemPrompt: '', createdAt: '', updatedAt: '' },
  ])
  const res = result(await handler(makeEvent('GET', '/api/projects/{projectId}', undefined, { projectId: 'proj-1' }) as any))
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body ?? '{}')
  expect(body.chats).toHaveLength(0)
})

// ── PATCH /api/projects/{projectId} ───────────────────────────────────────────

test('PATCH /api/projects/{projectId} updates name → 200 { ok: true }', async () => {
  mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'Old' })
  mockDynamo.updateProjectFields.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('PATCH', '/api/projects/{projectId}', { name: 'New Name' }, { projectId: 'proj-1' }) as any))
  expect(res.statusCode).toBe(200)
  expect(JSON.parse(res.body ?? '{}')).toEqual({ ok: true })
  expect(mockDynamo.updateProjectFields).toHaveBeenCalledWith(
    'user-1', 'proj-1', expect.objectContaining({ name: 'New Name' }),
  )
})

test('PATCH /api/projects/{projectId} rejects empty name → 400', async () => {
  mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'Old' })
  const res = result(await handler(makeEvent('PATCH', '/api/projects/{projectId}', { name: '' }, { projectId: 'proj-1' }) as any))
  expect(res.statusCode).toBe(400)
})

test('PATCH /api/projects/{projectId} rejects non-boolean memoryEnabled → 400', async () => {
  mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'X' })
  const res = result(await handler(makeEvent('PATCH', '/api/projects/{projectId}', { memoryEnabled: 'yes' }, { projectId: 'proj-1' }) as any))
  expect(res.statusCode).toBe(400)
  expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: expect.stringContaining('boolean') })
})

test('PATCH /api/projects/{projectId} returns 404 when project not found', async () => {
  mockDynamo.getProject.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('PATCH', '/api/projects/{projectId}', { name: 'X' }, { projectId: 'no-such' }) as any))
  expect(res.statusCode).toBe(404)
})

// ── DELETE /api/projects/{projectId} ─────────────────────────────────────────

test('DELETE /api/projects/{projectId} unassigns member chats and deletes project → 204', async () => {
  mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
  mockDynamo.listChats.mockResolvedValue([
    { PK: 'USER#user-1', SK: 'CHAT#c1', title: 'C1', model: 'x', systemPrompt: '', createdAt: '', updatedAt: '', projectId: 'proj-1' },
    { PK: 'USER#user-1', SK: 'CHAT#c2', title: 'C2', model: 'x', systemPrompt: '', createdAt: '', updatedAt: '', projectId: 'proj-1' },
    { PK: 'USER#user-1', SK: 'CHAT#c3', title: 'C3', model: 'x', systemPrompt: '', createdAt: '', updatedAt: '' },
  ])
  mockDynamo.updateChatProject.mockResolvedValue(undefined)
  mockDdbSend.mockResolvedValue({ Items: [] })
  mockDynamo.batchDeleteKeys.mockResolvedValue(undefined)
  mockDynamo.deleteProject.mockResolvedValue(undefined)

  const res = result(await handler(makeEvent('DELETE', '/api/projects/{projectId}', undefined, { projectId: 'proj-1' }) as any))
  expect(res.statusCode).toBe(204)

  // Only c1 and c2 belong to proj-1; c3 does not
  expect(mockDynamo.updateChatProject).toHaveBeenCalledTimes(2)
  expect(mockDynamo.updateChatProject).toHaveBeenCalledWith('user-1', 'c1', null)
  expect(mockDynamo.updateChatProject).toHaveBeenCalledWith('user-1', 'c2', null)
  // c3 must NOT be unassigned
  expect(mockDynamo.updateChatProject).not.toHaveBeenCalledWith('user-1', 'c3', null)

  expect(mockDynamo.deleteProject).toHaveBeenCalledWith('user-1', 'proj-1')
})

test('DELETE /api/projects/{projectId} returns 404 when project not found', async () => {
  mockDynamo.getProject.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('DELETE', '/api/projects/{projectId}', undefined, { projectId: 'no-such' }) as any))
  expect(res.statusCode).toBe(404)
  expect(mockDynamo.deleteProject).not.toHaveBeenCalled()
})

test('DELETE /api/projects/{projectId} cascade does NOT delete chats themselves', async () => {
  mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
  mockDynamo.listChats.mockResolvedValue([
    { PK: 'USER#user-1', SK: 'CHAT#c1', title: 'C1', model: 'x', systemPrompt: '', createdAt: '', updatedAt: '', projectId: 'proj-1' },
  ])
  mockDynamo.updateChatProject.mockResolvedValue(undefined)
  mockDdbSend.mockResolvedValue({ Items: [] })
  mockDynamo.batchDeleteKeys.mockResolvedValue(undefined)
  mockDynamo.deleteProject.mockResolvedValue(undefined)

  await handler(makeEvent('DELETE', '/api/projects/{projectId}', undefined, { projectId: 'proj-1' }) as any)

  // Chats themselves must not be deleted
  expect(mockDynamo.deleteChat).not.toHaveBeenCalled()
  // Chat is only unassigned, not deleted
  expect(mockDynamo.updateChatProject).toHaveBeenCalledWith('user-1', 'c1', null)
})

test('DELETE /api/projects/{projectId} deletes sub-resources when they exist', async () => {
  mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
  mockDynamo.listChats.mockResolvedValue([])
  mockDynamo.updateChatProject.mockResolvedValue(undefined)
  // Simulate sub-resources existing under PROJECT#proj-1
  mockDdbSend.mockResolvedValue({
    Items: [
      { PK: 'PROJECT#proj-1', SK: 'MEM#mem-1' },
      { PK: 'PROJECT#proj-1', SK: 'FILE#file-1' },
    ],
  })
  mockDynamo.batchDeleteKeys.mockResolvedValue(undefined)
  mockDynamo.deleteProject.mockResolvedValue(undefined)

  const res = result(await handler(makeEvent('DELETE', '/api/projects/{projectId}', undefined, { projectId: 'proj-1' }) as any))
  expect(res.statusCode).toBe(204)

  expect(mockDynamo.batchDeleteKeys).toHaveBeenCalledWith([
    { PK: 'PROJECT#proj-1', SK: 'MEM#mem-1' },
    { PK: 'PROJECT#proj-1', SK: 'FILE#file-1' },
  ])
  expect(mockDynamo.deleteProject).toHaveBeenCalledWith('user-1', 'proj-1')
})

test('DELETE /api/projects/{projectId} skips batchDeleteKeys when no sub-resources', async () => {
  mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
  mockDynamo.listChats.mockResolvedValue([])
  mockDdbSend.mockResolvedValue({ Items: [] })
  mockDynamo.deleteProject.mockResolvedValue(undefined)

  await handler(makeEvent('DELETE', '/api/projects/{projectId}', undefined, { projectId: 'proj-1' }) as any)

  expect(mockDynamo.batchDeleteKeys).not.toHaveBeenCalled()
})

// ── GET /api/projects/{projectId}/memory ──────────────────────────────────────

test('GET /api/projects/{projectId}/memory returns memories list', async () => {
  mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
  mockDynamo.listProjectMemories.mockResolvedValue([
    { memId: 'mem-1', text: 'Fact A', category: 'preference', createdAt: 'ca', updatedAt: 'ua' },
    { memId: 'mem-2', text: 'Fact B', category: 'identity', createdAt: 'cb', updatedAt: 'ub' },
  ])
  const res = result(await handler(makeEvent('GET', '/api/projects/{projectId}/memory', undefined, { projectId: 'proj-1' }) as any))
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body ?? '{}')
  expect(body.memories).toHaveLength(2)
  expect(body.memories[0]).toEqual({ memId: 'mem-1', text: 'Fact A', category: 'preference', createdAt: 'ca', updatedAt: 'ua' })
  expect(body.memories[1]).toEqual({ memId: 'mem-2', text: 'Fact B', category: 'identity', createdAt: 'cb', updatedAt: 'ub' })
})

test('GET /api/projects/{projectId}/memory returns empty list when no memories', async () => {
  mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
  mockDynamo.listProjectMemories.mockResolvedValue([])
  const res = result(await handler(makeEvent('GET', '/api/projects/{projectId}/memory', undefined, { projectId: 'proj-1' }) as any))
  expect(res.statusCode).toBe(200)
  expect(JSON.parse(res.body ?? '{}').memories).toEqual([])
})

test('GET /api/projects/{projectId}/memory returns 404 if project not found', async () => {
  mockDynamo.getProject.mockResolvedValue(undefined)
  const res = result(await handler(makeEvent('GET', '/api/projects/{projectId}/memory', undefined, { projectId: 'no-such' }) as any))
  expect(res.statusCode).toBe(404)
  expect(mockDynamo.listProjectMemories).not.toHaveBeenCalled()
})

// ── DELETE /api/projects/{projectId}/memory/{memId} ───────────────────────────

test('DELETE /api/projects/{projectId}/memory/{memId} returns 204 on success', async () => {
  mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
  mockDynamo.deleteProjectMemory.mockResolvedValue(undefined)
  const res = result(await handler(
    makeEvent('DELETE', '/api/projects/{projectId}/memory/{memId}', undefined, { projectId: 'proj-1', memId: 'mem-1' }) as any,
  ))
  expect(res.statusCode).toBe(204)
  expect(mockDynamo.deleteProjectMemory).toHaveBeenCalledWith('proj-1', 'mem-1')
})

test('DELETE /api/projects/{projectId}/memory/{memId} returns 404 if project not found', async () => {
  mockDynamo.getProject.mockResolvedValue(undefined)
  const res = result(await handler(
    makeEvent('DELETE', '/api/projects/{projectId}/memory/{memId}', undefined, { projectId: 'no-such', memId: 'mem-1' }) as any,
  ))
  expect(res.statusCode).toBe(404)
  expect(mockDynamo.deleteProjectMemory).not.toHaveBeenCalled()
})

test('DELETE /api/projects/{projectId}/memory/{memId} returns 400 when memId missing', async () => {
  mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
  const res = result(await handler(
    makeEvent('DELETE', '/api/projects/{projectId}/memory/{memId}', undefined, { projectId: 'proj-1' }) as any,
  ))
  expect(res.statusCode).toBe(400)
  expect(mockDynamo.deleteProjectMemory).not.toHaveBeenCalled()
})

// ── File routes ───────────────────────────────────────────────────────────────

describe('File routes', () => {
  const fileRecord = {
    PK: 'PROJECT#proj-1', SK: 'FILE#file-1',
    fileId: 'file-1',
    filename: 'report.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    s3Key: 'attachments/user-1/project/proj-1/file-1/report.pdf',
    status: 'ready',
    microLabel: 'A PDF report',
    summary: 'Detailed summary.',
    inclusion: 'auto',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  }

  // ── POST /api/projects/{projectId}/files ─────────────────────────────────────

  test('POST /files: creates file record with status uploading, returns fileId/s3Key/uploadUrl with 201', async () => {
    mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
    mockDynamo.buildProjectFileKey.mockReturnValue({ PK: 'PROJECT#proj-1', SK: 'FILE#new-file' })
    mockDynamo.putProjectFile.mockResolvedValue(undefined)
    mockAttachments.projectFilePrefix.mockReturnValue('attachments/user-1/project/proj-1/')
    mockAttachments.presignPut.mockResolvedValue('https://s3.example.com/upload-url')

    const res = result(await handler(makeEvent('POST', '/api/projects/{projectId}/files', {
      filename: 'report.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
    }, { projectId: 'proj-1' }) as any))

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body ?? '{}')
    expect(typeof body.fileId).toBe('string')
    expect(body.fileId.length).toBeGreaterThan(0)
    expect(typeof body.s3Key).toBe('string')
    expect(body.uploadUrl).toBe('https://s3.example.com/upload-url')
    expect(mockDynamo.putProjectFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
        status: 'uploading',
        inclusion: 'auto',
      }),
    )
  })

  test('POST /files: 404 if project not found', async () => {
    mockDynamo.getProject.mockResolvedValue(undefined)
    const res = result(await handler(makeEvent('POST', '/api/projects/{projectId}/files', {
      filename: 'f.pdf', contentType: 'application/pdf', sizeBytes: 100,
    }, { projectId: 'no-such' }) as any))
    expect(res.statusCode).toBe(404)
    expect(mockDynamo.putProjectFile).not.toHaveBeenCalled()
  })

  test('POST /files: 400 if missing required fields', async () => {
    mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
    const res = result(await handler(makeEvent('POST', '/api/projects/{projectId}/files', {
      filename: 'f.pdf',
      // missing contentType and sizeBytes
    }, { projectId: 'proj-1' }) as any))
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: expect.stringContaining('Missing required fields') })
  })

  test('POST /files: 400 if validateAttachment throws', async () => {
    mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
    mockAttachments.validateAttachment.mockImplementation(() => { throw new Error('File too large: 99999 > 1048576 bytes') })
    const res = result(await handler(makeEvent('POST', '/api/projects/{projectId}/files', {
      filename: 'big.txt', contentType: 'text/plain', sizeBytes: 99999,
    }, { projectId: 'proj-1' }) as any))
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: expect.stringContaining('large') })
  })

  // ── PUT /api/projects/{projectId}/files/{fileId} ─────────────────────────────

  test('PUT /files/{fileId}: calls summarizeFile, updates status to ready, returns file', async () => {
    mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
    mockDynamo.getProjectFile
      .mockResolvedValueOnce(fileRecord)       // first call to get file to process
      .mockResolvedValueOnce({ ...fileRecord, status: 'ready', microLabel: 'My Label', summary: 'My Summary' }) // second call after update
    mockDynamo.updateProjectFile.mockResolvedValue(undefined)
    mockProjectFiles.summarizeFile.mockResolvedValue({
      microLabel: 'My Label',
      summary: 'My Summary',
    })

    const res = result(await handler(makeEvent('PUT', '/api/projects/{projectId}/files/{fileId}', undefined, {
      projectId: 'proj-1', fileId: 'file-1',
    }) as any))

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body ?? '{}')
    expect(body.file).toBeDefined()
    expect(mockDynamo.updateProjectFile).toHaveBeenCalledWith('proj-1', 'file-1', { status: 'processing' })
    expect(mockDynamo.updateProjectFile).toHaveBeenCalledWith('proj-1', 'file-1', expect.objectContaining({
      status: 'ready',
      microLabel: 'My Label',
      summary: 'My Summary',
    }))
    expect(mockProjectFiles.summarizeFile).toHaveBeenCalledWith(expect.objectContaining({
      s3Key: fileRecord.s3Key,
      contentType: fileRecord.contentType,
      filename: fileRecord.filename,
    }))
  })

  test('PUT /files/{fileId}: 500 + status error on summarizeFile failure', async () => {
    mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
    mockDynamo.getProjectFile.mockResolvedValue(fileRecord)
    mockDynamo.updateProjectFile.mockResolvedValue(undefined)
    mockProjectFiles.summarizeFile.mockRejectedValue(new Error('Bedrock timeout'))

    const res = result(await handler(makeEvent('PUT', '/api/projects/{projectId}/files/{fileId}', undefined, {
      projectId: 'proj-1', fileId: 'file-1',
    }) as any))

    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: expect.stringContaining('processing failed') })
    expect(mockDynamo.updateProjectFile).toHaveBeenCalledWith('proj-1', 'file-1', { status: 'error' })
  })

  test('PUT /files/{fileId}: 404 if file not found', async () => {
    mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
    mockDynamo.getProjectFile.mockResolvedValue(undefined)

    const res = result(await handler(makeEvent('PUT', '/api/projects/{projectId}/files/{fileId}', undefined, {
      projectId: 'proj-1', fileId: 'no-such-file',
    }) as any))

    expect(res.statusCode).toBe(404)
    expect(mockProjectFiles.summarizeFile).not.toHaveBeenCalled()
  })

  // ── GET /api/projects/{projectId}/files ──────────────────────────────────────

  test('GET /files: returns list with inclusion defaulting to auto', async () => {
    mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
    // One file with explicit inclusion, one without
    mockDynamo.listProjectFiles.mockResolvedValue([
      fileRecord,
      { ...fileRecord, fileId: 'file-2', filename: 'pic.png', inclusion: undefined },
    ])

    const res = result(await handler(makeEvent('GET', '/api/projects/{projectId}/files', undefined, {
      projectId: 'proj-1',
    }) as any))

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body ?? '{}')
    expect(body.files).toHaveLength(2)
    expect(body.files[0].inclusion).toBe('auto')
    expect(body.files[1].inclusion).toBe('auto') // defaulted from undefined
    expect(body.files[0].fileId).toBe('file-1')
  })

  test('GET /files: 404 if project not found', async () => {
    mockDynamo.getProject.mockResolvedValue(undefined)
    const res = result(await handler(makeEvent('GET', '/api/projects/{projectId}/files', undefined, {
      projectId: 'no-such',
    }) as any))
    expect(res.statusCode).toBe(404)
    expect(mockDynamo.listProjectFiles).not.toHaveBeenCalled()
  })

  // ── PATCH /api/projects/{projectId}/files/{fileId} ───────────────────────────

  test('PATCH /files/{fileId}: updates inclusion mode', async () => {
    mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
    mockDynamo.getProjectFile.mockResolvedValue(fileRecord)
    mockDynamo.updateProjectFile.mockResolvedValue(undefined)

    const res = result(await handler(makeEvent('PATCH', '/api/projects/{projectId}/files/{fileId}', {
      inclusion: 'always',
    }, { projectId: 'proj-1', fileId: 'file-1' }) as any))

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body ?? '{}')).toEqual({ ok: true })
    expect(mockDynamo.updateProjectFile).toHaveBeenCalledWith('proj-1', 'file-1', { inclusion: 'always' })
  })

  test('PATCH /files/{fileId}: 400 for invalid inclusion value', async () => {
    mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
    mockDynamo.getProjectFile.mockResolvedValue(fileRecord)

    const res = result(await handler(makeEvent('PATCH', '/api/projects/{projectId}/files/{fileId}', {
      inclusion: 'sometimes',
    }, { projectId: 'proj-1', fileId: 'file-1' }) as any))

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body ?? '{}')).toMatchObject({ message: expect.stringContaining('inclusion') })
    expect(mockDynamo.updateProjectFile).not.toHaveBeenCalled()
  })

  test('PATCH /files/{fileId}: 404 if file not found', async () => {
    mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
    mockDynamo.getProjectFile.mockResolvedValue(undefined)

    const res = result(await handler(makeEvent('PATCH', '/api/projects/{projectId}/files/{fileId}', {
      inclusion: 'never',
    }, { projectId: 'proj-1', fileId: 'no-such-file' }) as any))

    expect(res.statusCode).toBe(404)
  })

  // ── DELETE /api/projects/{projectId}/files/{fileId} ──────────────────────────

  test('DELETE /files/{fileId}: deletes S3 objects + dynamo row, returns 204', async () => {
    mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
    mockDynamo.getProjectFile.mockResolvedValue(fileRecord)
    mockDynamo.deleteProjectFile.mockResolvedValue(undefined)

    const res = result(await handler(makeEvent('DELETE', '/api/projects/{projectId}/files/{fileId}', undefined, {
      projectId: 'proj-1', fileId: 'file-1',
    }) as any))

    expect(res.statusCode).toBe(204)
    expect(mockAttachments.deleteS3Objects).toHaveBeenCalledWith([fileRecord.s3Key])
    expect(mockDynamo.deleteProjectFile).toHaveBeenCalledWith('proj-1', 'file-1')
  })

  test('DELETE /files/{fileId}: also deletes extractedTextKey sidecar if present', async () => {
    const fileWithSidecar = { ...fileRecord, extractedTextKey: 'attachments/user-1/project/proj-1/file-1/report.pdf.extracted.txt' }
    mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
    mockDynamo.getProjectFile.mockResolvedValue(fileWithSidecar)
    mockDynamo.deleteProjectFile.mockResolvedValue(undefined)

    await handler(makeEvent('DELETE', '/api/projects/{projectId}/files/{fileId}', undefined, {
      projectId: 'proj-1', fileId: 'file-1',
    }) as any)

    expect(mockAttachments.deleteS3Objects).toHaveBeenCalledWith([
      fileRecord.s3Key,
      fileWithSidecar.extractedTextKey,
    ])
  })

  test('DELETE /files/{fileId}: 404 if file not found', async () => {
    mockDynamo.getProject.mockResolvedValue({ PK: 'USER#user-1', SK: 'PROJECT#proj-1', name: 'P' })
    mockDynamo.getProjectFile.mockResolvedValue(undefined)

    const res = result(await handler(makeEvent('DELETE', '/api/projects/{projectId}/files/{fileId}', undefined, {
      projectId: 'proj-1', fileId: 'no-such-file',
    }) as any))

    expect(res.statusCode).toBe(404)
    expect(mockAttachments.deleteS3Objects).not.toHaveBeenCalled()
    expect(mockDynamo.deleteProjectFile).not.toHaveBeenCalled()
  })

  test('DELETE /files/{fileId}: 404 if project not found', async () => {
    mockDynamo.getProject.mockResolvedValue(undefined)

    const res = result(await handler(makeEvent('DELETE', '/api/projects/{projectId}/files/{fileId}', undefined, {
      projectId: 'no-such', fileId: 'file-1',
    }) as any))

    expect(res.statusCode).toBe(404)
    expect(mockDynamo.deleteProjectFile).not.toHaveBeenCalled()
  })
})
