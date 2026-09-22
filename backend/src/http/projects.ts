import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { newId } from '../lib/ids'
import {
  listProjects,
  getProject,
  putProject,
  updateProjectFields,
  deleteProject,
  listChats,
  updateChatProject,
  batchDeleteKeys,
  buildProjectKey,
  listProjectMemories,
  putProjectMemory,
  buildProjectMemKey,
  deleteProjectMemory,
  updateProjectMemory,
  listProjectFiles,
  getProjectFile,
  putProjectFile,
  updateProjectFile,
  deleteProjectFile,
  buildProjectFileKey,
  ddb,
  TABLE,
} from '../lib/dynamo'
import { subFromClaims } from '../lib/auth'
import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import { summarizeFile } from '../lib/projectFiles'
import { validateAttachment, signCloudFrontUrl, presignPut, projectFilePrefix, deleteProjectObjects, deleteS3Objects } from '../lib/attachments'
import { chatDto } from '../lib/chatDto'
import { isValidModelId } from '../config/models'

const projectDto = (i: Record<string, unknown>) => ({
  projectId: (i.SK as string).replace('PROJECT#', ''),
  name: i.name, description: i.description, instructions: i.instructions,
  memoryEnabled: i.memoryEnabled, defaultModel: i.defaultModel, modelSettings: i.modelSettings,
  createdAt: i.createdAt, updatedAt: i.updatedAt,
})

const ok = (body: unknown, status = 200): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const err = (status: number, message: string): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message }),
})

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const sub = subFromClaims(event.requestContext.authorizer.jwt.claims)
  const route = event.routeKey

  if (route === 'GET /api/projects') {
    const items = await listProjects(sub)
    const projects = items.map(projectDto)
    return ok({ projects })
  }

  if (route === 'POST /api/projects') {
    let body: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(event.body ?? '{}')
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      return err(400, 'Invalid JSON body')
    }
    if (!body.name || typeof body.name !== 'string' || (body.name as string).trim() === '') {
      return err(400, 'name is required and must be a non-empty string')
    }
    const projectId = newId()
    const now = new Date().toISOString()
    await putProject({
      ...buildProjectKey(sub, projectId),
      projectId,
      name: body.name as string,
      description: typeof body.description === 'string' ? body.description : '',
      instructions: typeof body.instructions === 'string' ? body.instructions : '',
      memoryEnabled: body.memoryEnabled !== false,
      createdAt: now,
      updatedAt: now,
    })
    console.log(JSON.stringify({ event: 'project_created', sub, projectId }))
    return ok({ projectId }, 201)
  }

  const projectId = event.pathParameters?.projectId
  if (!projectId) return err(400, 'Missing projectId')

  if (route === 'GET /api/projects/{projectId}') {
    const project = await getProject(sub, projectId)
    if (!project) return err(404, 'Not found')

    const allChats = await listChats(sub)
    const memberChats = allChats.filter(c => c.projectId === projectId)
    const chats = memberChats.map(c => chatDto(c))
    return ok({ project: projectDto(project), chats })
  }

  if (route === 'PATCH /api/projects/{projectId}') {
    let body: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(event.body ?? '{}')
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      return err(400, 'Invalid JSON body')
    }
    const project = await getProject(sub, projectId)
    if (!project) return err(404, 'Not found')

    if (body.name !== undefined && (typeof body.name !== 'string' || (body.name as string).trim() === '')) {
      return err(400, 'name cannot be empty')
    }

    if (body.memoryEnabled !== undefined && typeof body.memoryEnabled !== 'boolean') {
      return err(400, 'memoryEnabled must be a boolean')
    }

    if (body.modelSettings !== undefined && (
      typeof body.modelSettings !== 'object' || body.modelSettings === null || Array.isArray(body.modelSettings)
    )) {
      return err(400, 'modelSettings must be a plain object')
    }

    if (body.defaultModel !== undefined && body.defaultModel !== null &&
        (typeof body.defaultModel !== 'string' || !isValidModelId(body.defaultModel))) {
      return err(400, 'Invalid default model')
    }

    const filteredFields: Partial<{
      name: string
      description: string
      instructions: string
      memoryEnabled: boolean
      defaultModel: string | null
      modelSettings: Record<string, unknown>
    }> = {}
    if (body.name !== undefined) filteredFields.name = body.name as string
    if (body.description !== undefined) filteredFields.description = body.description as string
    if (body.instructions !== undefined) filteredFields.instructions = body.instructions as string
    if (body.memoryEnabled !== undefined) filteredFields.memoryEnabled = body.memoryEnabled as boolean
    if (body.defaultModel !== undefined) filteredFields.defaultModel = body.defaultModel as string | null
    if (body.modelSettings !== undefined) filteredFields.modelSettings = body.modelSettings as Record<string, unknown>

    await updateProjectFields(sub, projectId, filteredFields)
    console.log(JSON.stringify({ event: 'project_updated', sub, projectId }))
    return ok({ ok: true })
  }

  if (route === 'DELETE /api/projects/{projectId}') {
    const project = await getProject(sub, projectId)
    if (!project) return err(404, 'Not found')

    // 1. Un-assign member chats — deleting a project must not delete the chats in it
    const allChats = await listChats(sub)
    const projectChats = allChats.filter(c => c.projectId === projectId)
    await Promise.all(
      projectChats.map(c => updateChatProject(sub, (c.SK as string).replace('CHAT#', ''), null)),
    )

    // 2. Delete all sub-resources (MEM# and FILE# rows) under PROJECT#<projectId>
    const subRes = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `PROJECT#${projectId}` },
      ProjectionExpression: 'PK, SK',
    }))
    const subKeys = (subRes.Items ?? []).map(i => ({ PK: i.PK as string, SK: i.SK as string }))
    if (subKeys.length > 0) await batchDeleteKeys(subKeys)

    // 3. Delete project S3 objects (files uploaded to this project)
    await deleteProjectObjects(sub, projectId)

    // 4. Delete the project record itself
    await deleteProject(sub, projectId)

    console.log(JSON.stringify({ event: 'project_deleted', sub, projectId }))
    return { statusCode: 204, body: '' }
  }

  if (route === 'POST /api/projects/{projectId}/memory') {
    if (!await getProject(sub, projectId)) return err(404, 'Not found')
    let body: Record<string, unknown>
    try { body = JSON.parse(event.body ?? '{}') } catch { return err(400, 'Invalid JSON body') }
    if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 10000) return err(400, 'A fact must contain 1–10000 characters')
    const category = typeof body.category === 'string' ? body.category : 'fact'
    if (!['decision', 'convention', 'fact', 'constraint', 'glossary', 'other'].includes(category)) return err(400, 'Invalid category')
    const memId = newId()
    const now = new Date().toISOString()
    // User-maintained facts survive automatic reconciliation. See docs/adr/0046-project-knowledge-controls.md.
    await putProjectMemory({ ...buildProjectMemKey(projectId, memId), memId, text: body.text.trim(), category, userEdited: true, createdAt: now, updatedAt: now })
    return ok({ memId }, 201)
  }

  if (route === 'GET /api/projects/{projectId}/memory') {
    const project = await getProject(sub, projectId)
    if (!project) return err(404, 'Not found')
    const items = await listProjectMemories(projectId)
    const memories = items.map(i => ({
      memId: i.memId,
      userEdited: i.userEdited,
      sourceChatId: i.sourceChatId,
      text: i.text,
      category: i.category,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    }))
    return ok({ memories })
  }

  if (route === 'DELETE /api/projects/{projectId}/memory/{memId}') {
    const memId = event.pathParameters?.memId
    if (!memId) return err(400, 'Missing memId')
    const project = await getProject(sub, projectId)
    if (!project) return err(404, 'Not found')
    await deleteProjectMemory(projectId, memId)
    return { statusCode: 204, body: '' }
  }

  if (route === 'PATCH /api/projects/{projectId}/memory/{memId}') {
    const memId = event.pathParameters?.memId
    if (!memId) return err(400, 'Missing memId')
    const project = await getProject(sub, projectId)
    if (!project) return err(404, 'Not found')

    let body: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(event.body ?? '{}')
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch { return err(400, 'Invalid JSON body') }

    if (body.text !== undefined && (typeof body.text !== 'string' || body.text.trim() === '')) {
      return err(400, 'text cannot be empty')
    }
    const validCategories = ['decision', 'convention', 'fact', 'constraint', 'glossary', 'other']
    if (body.category !== undefined && !validCategories.includes(body.category as string)) {
      return err(400, `category must be one of: ${validCategories.join(', ')}`)
    }

    const fields: Partial<{ text: string; category: string }> = {}
    if (body.text !== undefined) fields.text = (body.text as string).trim()
    if (body.category !== undefined) fields.category = body.category as string
    await updateProjectMemory(projectId, memId, { ...fields, userEdited: true })
    return ok({ ok: true })
  }

  // ── File routes ─────────────────────────────────────────────────────────────

  if (route === 'POST /api/projects/{projectId}/files') {
    const project = await getProject(sub, projectId)
    if (!project) return err(404, 'Not found')

    let body: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(event.body ?? '{}')
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch { return err(400, 'Invalid JSON body') }

    const { filename, contentType, sizeBytes } = body as { filename?: string; contentType?: string; sizeBytes?: number }
    if (!filename || !contentType || typeof sizeBytes !== 'number') {
      return err(400, 'Missing required fields: filename, contentType, sizeBytes')
    }
    try { validateAttachment(contentType, sizeBytes, filename) } catch (e) { return err(400, (e as Error).message) }

    const fileId = newId()
    const safeName = (filename as string).replace(/[/\\]/g, '-').replace(/\0/g, '').replace(/^\.+/, '_')
    const s3Key = `${projectFilePrefix(sub, projectId)}${fileId}/${safeName}`
    const now = new Date().toISOString()
    await putProjectFile({
      ...buildProjectFileKey(projectId, fileId),
      fileId,
      filename: safeName,
      contentType,
      sizeBytes,
      s3Key,
      status: 'uploading',
      inclusion: 'auto',
      createdAt: now,
      updatedAt: now,
    })
    const uploadUrl = await presignPut(s3Key, contentType)
    console.log(JSON.stringify({ event: 'project_file_upload_requested', sub, projectId, fileId }))
    return ok({ fileId, s3Key, uploadUrl }, 201)
  }

  if (route === 'PUT /api/projects/{projectId}/files/{fileId}') {
    const fileId = event.pathParameters?.fileId
    if (!fileId) return err(400, 'Missing fileId')

    const project = await getProject(sub, projectId)
    if (!project) return err(404, 'Not found')

    const fileItem = await getProjectFile(projectId, fileId)
    if (!fileItem) return err(404, 'File not found')

    // Mark processing
    await updateProjectFile(projectId, fileId, { status: 'processing' })

    try {
      const summary = await summarizeFile({
        s3Key: fileItem.s3Key as string,
        contentType: fileItem.contentType as string,
        filename: fileItem.filename as string,
        projectId,
      })
      await updateProjectFile(projectId, fileId, {
        status: 'ready',
        microLabel: summary.microLabel,
        summary: summary.summary,
        ...(summary.extractedTextKey ? { extractedTextKey: summary.extractedTextKey } : {}),
      })
      const updated = await getProjectFile(projectId, fileId)
      return ok({ file: updated })
    } catch (processErr) {
      await updateProjectFile(projectId, fileId, { status: 'error' })
      console.error(JSON.stringify({ event: 'file_summary_error', projectId, fileId, error: String(processErr) }))
      return err(500, 'File processing failed')
    }
  }

  if (route === 'GET /api/projects/{projectId}/files') {
    const project = await getProject(sub, projectId)
    if (!project) return err(404, 'Not found')
    const items = await listProjectFiles(projectId)
    const files = await Promise.all(items.map(async i => ({
      fileId: i.fileId,
      filename: i.filename,
      contentType: i.contentType,
      sizeBytes: i.sizeBytes,
      s3Key: i.s3Key,
      status: ['uploading', 'processing'].includes(i.status as string) && Date.now() - Date.parse(i.updatedAt as string) > 15 * 60 * 1000 ? 'error' : i.status,
      errorMessage: i.status === 'error' || (['uploading', 'processing'].includes(i.status as string) && Date.now() - Date.parse(i.updatedAt as string) > 15 * 60 * 1000) ? 'Processing did not finish. Retry, or remove this file and upload it again.' : undefined,
      url: i.status === 'ready' ? await signCloudFrontUrl(i.s3Key as string) : undefined,
      microLabel: i.microLabel,
      summary: i.summary,
      inclusion: i.inclusion ?? 'auto',
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    })))
    return ok({ files })
  }

  if (route === 'PATCH /api/projects/{projectId}/files/{fileId}') {
    const fileId = event.pathParameters?.fileId
    if (!fileId) return err(400, 'Missing fileId')

    const project = await getProject(sub, projectId)
    if (!project) return err(404, 'Not found')

    const fileItem = await getProjectFile(projectId, fileId)
    if (!fileItem) return err(404, 'File not found')

    let body: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(event.body ?? '{}')
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch { return err(400, 'Invalid JSON body') }

    const { inclusion, summary, microLabel } = body
    if (inclusion !== undefined && !['auto', 'always', 'never'].includes(inclusion as string)) {
      return err(400, "inclusion must be 'auto', 'always', or 'never'")
    }
    if (summary !== undefined && (typeof summary !== 'string' || summary.trim() === '')) {
      return err(400, 'summary cannot be empty')
    }
    if (microLabel !== undefined && (typeof microLabel !== 'string' || microLabel.trim() === '')) {
      return err(400, 'microLabel cannot be empty')
    }

    const fields: Partial<{ inclusion: string; summary: string; microLabel: string }> = {}
    if (inclusion !== undefined) fields.inclusion = inclusion as string
    if (summary !== undefined) fields.summary = (summary as string).trim()
    if (microLabel !== undefined) fields.microLabel = (microLabel as string).trim()
    if (Object.keys(fields).length > 0) {
      await updateProjectFile(projectId, fileId, fields)
    }
    return ok({ ok: true })
  }

  if (route === 'DELETE /api/projects/{projectId}/files/{fileId}') {
    const fileId = event.pathParameters?.fileId
    if (!fileId) return err(400, 'Missing fileId')

    const project = await getProject(sub, projectId)
    if (!project) return err(404, 'Not found')

    const fileItem = await getProjectFile(projectId, fileId)
    if (!fileItem) return err(404, 'File not found')

    // Delete S3 objects (main file + any extracted text sidecar)
    const s3Key = fileItem.s3Key as string
    const keysToDelete = [s3Key]
    if (fileItem.extractedTextKey) keysToDelete.push(fileItem.extractedTextKey as string)
    await deleteS3Objects(keysToDelete)

    await deleteProjectFile(projectId, fileId)
    console.log(JSON.stringify({ event: 'project_file_deleted', sub, projectId, fileId }))
    return { statusCode: 204, body: '' }
  }

  return err(404, 'Not found')
}
