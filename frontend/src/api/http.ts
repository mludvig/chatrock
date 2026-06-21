import { ENV } from '../env'

let _accessToken = ''

export function setAccessToken(token: string) {
  _accessToken = token
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ENV.apiBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${_accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status))
    throw new Error(text)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export interface Chat {
  chatId: string
  title: string
  model: string
  systemPrompt: string
  createdAt: string
  updatedAt: string
  activeLeafId?: string
  modelSettings?: ModelSettings
  projectId?: string
  summary?: string
}

export interface Project {
  projectId: string
  name: string
  description?: string
  instructions?: string
  memoryEnabled?: boolean
  defaultModel?: string
  modelSettings?: ModelSettings
  createdAt: string
  updatedAt: string
}

// ── Display types returned by GET /messages (format C) ───────────────────────

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
}

export type Step =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; toolUseId: string; name: string; input: string; result?: string; isError?: boolean; searchResults?: Array<{ title: string; url: string; description: string }>; screenshotUrls?: string[] }
  | { kind: 'attachment'; attachmentKind: 'image' | 'document'; filename: string; contentType: string; url: string; s3Key: string; mode?: 'standard' | 'rich' }

export interface Message {
  msgId: string
  parentId?: string | null
  role: 'user' | 'assistant'
  // Format C: steps[] is the canonical shape
  steps: Step[]
  model: string
  createdAt: string
  usage?: TokenUsage
  // Per-turn inference metadata (F1/F2)
  thinkingEffort?: string
  webSearchEnabled?: boolean
  // Convenience: a text step's content for the legacy Message.content access pattern
  // (kept so callers that only need the text can still work; derived from steps on load)
  content?: string
  // Sibling navigation metadata (Inc 4)
  siblingIndex?: number
  siblingCount?: number
  siblings?: string[]
  // Set on assistant bubbles that ended due to a stream error (partial answer)
  errored?: boolean
}

export interface ModelCapabilities {
  temperature: boolean
  topP: boolean
  topK: boolean
  thinking: 'adaptive' | 'none'
  attachments: boolean
}

export interface ModelSettings {
  temperature?: number
  topP?: number
  topK?: number
  thinkingEffort?: 'off' | 'low' | 'medium' | 'high' | 'max'
  webSearchEnabled?: boolean
  webSearchProvider?: 'jina' | 'agentcore'
  browserCoreEnabled?: boolean
  browserExtendedEnabled?: boolean
  memoryEnabled?: boolean
  answerLength?: 'default' | 'short' | 'extensive'
  injectCurrentDate?: boolean
}

export interface UserMemory {
  memId: string
  text: string
  category: 'identity' | 'preference' | 'style' | 'other'
  createdAt: string
  updatedAt: string
}

export interface ProjectMemory {
  memId: string
  text: string
  category: 'decision' | 'convention' | 'fact' | 'constraint' | 'glossary' | 'other'
  createdAt: string
  updatedAt: string
}

export interface ProjectFile {
  fileId: string
  filename: string
  contentType: string
  sizeBytes: number
  s3Key: string
  status: 'uploading' | 'processing' | 'ready' | 'error'
  microLabel?: string
  summary?: string
  extractedTextKey?: string
  inclusion: 'auto' | 'always' | 'never'
  createdAt: string
  updatedAt: string
}

export interface UserPreferences {
  persona?: string
  injectCurrentDate?: boolean
  answerLength?: 'default' | 'short' | 'extensive'
  defaultModel?: string
  thinkingEffort?: 'off' | 'low' | 'medium' | 'high' | 'max'
  webSearchEnabled?: boolean
  webSearchProvider?: 'jina' | 'agentcore'
  browserCoreEnabled?: boolean
  browserExtendedEnabled?: boolean
  temperature?: number
  topP?: number
  topK?: number
  showTokenStats?: boolean
}

export interface Model {
  id: string
  name: string
  capabilities: ModelCapabilities
}

export const THINKING_EFFORTS = ['off', 'low', 'medium', 'high', 'max'] as const

export function defaultSettings(caps: ModelCapabilities): ModelSettings {
  return {
    ...(caps.thinking !== 'none' ? { thinkingEffort: 'low' as const } : {}),
    webSearchEnabled: true,
    browserCoreEnabled: true,
    browserExtendedEnabled: false,
  }
}

// Carry over settings that are valid for the new model; fill missing with defaults
export function migrateSettings(prev: ModelSettings, caps: ModelCapabilities): ModelSettings {
  const defaults = defaultSettings(caps)
  // Pre-split-toggle settings only had a single `browserToolEnabled` (the old name for what
  // is now the scripted/Extended tool); carry an explicit `true` forward as Extended, but
  // Core always defaults on regardless of the old flag's value.
  const legacyBrowserToolEnabled = (prev as { browserToolEnabled?: boolean }).browserToolEnabled
  return {
    ...(caps.temperature && prev.temperature !== undefined ? { temperature: prev.temperature } : {}),
    ...(caps.topP && prev.topP !== undefined ? { topP: prev.topP } : {}),
    ...(caps.topK && prev.topK !== undefined ? { topK: prev.topK } : {}),
    ...(caps.thinking !== 'none' ? { thinkingEffort: prev.thinkingEffort ?? defaults.thinkingEffort } : {}),
    webSearchEnabled: prev.webSearchEnabled ?? true,
    browserCoreEnabled: prev.browserCoreEnabled ?? true,
    browserExtendedEnabled: prev.browserExtendedEnabled ?? legacyBrowserToolEnabled ?? false,
    memoryEnabled: prev.memoryEnabled ?? true,
  }
}

export const api = {
  listChats: ()                        => req<{ chats: Chat[] }>('GET', '/api/chats'),
  createChat: (model: string, systemPrompt: string, chatId?: string, modelSettings?: ModelSettings, projectId?: string) =>
    req<{ chatId: string }>('POST', '/api/chats', {
      model, systemPrompt,
      ...(chatId ? { chatId } : {}),
      ...(modelSettings ? { modelSettings } : {}),
      ...(projectId ? { projectId } : {}),
    }),
  renameChat: (chatId: string, title: string) =>
    req<void>('PATCH', `/api/chats/${chatId}`, { title }),
  updateSystemPrompt: (chatId: string, systemPrompt: string) =>
    req<void>('PATCH', `/api/chats/${chatId}`, { systemPrompt }),
  updateModel: (chatId: string, model: string) =>
    req<void>('PATCH', `/api/chats/${chatId}`, { model }),
  updateChatSettings: (chatId: string, settings: ModelSettings) =>
    req<void>('PATCH', `/api/chats/${chatId}`, { modelSettings: settings }),
  deleteChat: (chatId: string)         => req<void>('DELETE', `/api/chats/${chatId}`),
  listMessages: (chatId: string)       => req<{ bubbles: Message[]; conversationUsage: TokenUsage }>('GET', `/api/chats/${chatId}/messages`),
  setActiveLeaf: (chatId: string, activeLeafId: string) => req<void>('PATCH', `/api/chats/${chatId}`, { activeLeafId }),
  listModels: ()                       => req<{ models: Model[] }>('GET', '/api/models'),
  retitleChat: (chatId: string)        => req<{ title: string }>('POST', `/api/chats/${chatId}/retitle`),
  forkChat: (chatId: string, fromMsgId: string) =>
    req<{ chatId: string }>('POST', `/api/chats/${chatId}/fork`, { fromMsgId }),
  deleteBranch: (chatId: string, msgId: string) =>
    req<void>('DELETE', `/api/chats/${chatId}/messages/${msgId}`),
  getPreferences: ()                         => req<{ preferences: UserPreferences }>('GET', '/api/preferences'),
  savePreferences: (prefs: UserPreferences)  => req<{ ok: boolean }>('PUT', '/api/preferences', prefs),
  listMemory: ()                             => req<{ memories: UserMemory[] }>('GET', '/api/memory'),
  deleteMemory: (memId: string)              => req<void>('DELETE', `/api/memory/${memId}`),
  listProjects: () => req<{ projects: Project[] }>('GET', '/api/projects'),
  createProject: (name: string) => req<{ projectId: string }>('POST', '/api/projects', { name }),
  getProject: (projectId: string) => req<{ project: Project; chats: Chat[] }>('GET', `/api/projects/${projectId}`),
  updateProject: (projectId: string, fields: Partial<Pick<Project, 'name' | 'description' | 'instructions' | 'memoryEnabled' | 'defaultModel' | 'modelSettings'>>) =>
    req<{ ok: boolean }>('PATCH', `/api/projects/${projectId}`, fields),
  deleteProject: (projectId: string) => req<void>('DELETE', `/api/projects/${projectId}`),
  moveChatToProject: (chatId: string, projectId: string | null) =>
    req<void>('PATCH', `/api/chats/${chatId}`, { projectId }),
  listProjectMemory: (projectId: string) =>
    req<{ memories: ProjectMemory[] }>('GET', `/api/projects/${projectId}/memory`),
  deleteProjectMemory: (projectId: string, memId: string) =>
    req<void>('DELETE', `/api/projects/${projectId}/memory/${memId}`),
  listProjectFiles: (projectId: string) =>
    req<{ files: ProjectFile[] }>('GET', `/api/projects/${projectId}/files`),
  requestProjectFileUpload: (projectId: string, filename: string, contentType: string, sizeBytes: number) =>
    req<{ fileId: string; s3Key: string; uploadUrl: string }>('POST', `/api/projects/${projectId}/files`, { filename, contentType, sizeBytes }),
  finalizeProjectFile: (projectId: string, fileId: string) =>
    req<{ file: ProjectFile }>('PUT', `/api/projects/${projectId}/files/${fileId}`),
  setFileInclusion: (projectId: string, fileId: string, inclusion: 'auto' | 'always' | 'never') =>
    req<{ ok: boolean }>('PATCH', `/api/projects/${projectId}/files/${fileId}`, { inclusion }),
  deleteProjectFile: (projectId: string, fileId: string) =>
    req<void>('DELETE', `/api/projects/${projectId}/files/${fileId}`),
}

export interface UploadRequest {
  chatId: string
  filename: string
  contentType: string
  sizeBytes: number
}

export interface UploadResponse {
  s3Key: string
  uploadUrl: string
}

export async function requestUpload(uploadReq: UploadRequest): Promise<UploadResponse> {
  return req<UploadResponse>('POST', '/api/attachments', uploadReq)
}

export async function uploadToS3(uploadUrl: string, file: File): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type },
    // NOTE: presigned PUT already encodes AWS credentials; no Authorization header
  })
  if (!res.ok) throw new Error(`S3 upload failed: ${res.status}`)
}
