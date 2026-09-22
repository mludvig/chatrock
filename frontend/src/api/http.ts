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
  // Set when a message is submitted; what the chat list sorts by (see lib/sort.ts).
  lastMessageAt?: string
  activeLeafId?: string
  modelSettings?: ModelSettings
  projectId?: string
  summary?: string
  topics?: string[]
  // Independent flags — see "Sensitive & ephemeral chats" in backend/CLAUDE.md.
  // sensitive: excluded from memory/summary/search_history; masked in the chat list unless
  // the "show sensitive" filter is on. ephemeral: auto-deletes at expiresAt (the DynamoDB TTL
  // deadline, fixed at creation).
  sensitive?: boolean
  ephemeral?: boolean
  expiresAt?: string
  // Present while the chat's stored model is retired from config/models.ts — the backend
  // swapped `model` to the current default in the response only; the next send persists
  // whatever model it used, which clears this.
  modelMigratedFrom?: string
}

export interface Share {
  shareId: string
  mode: 'live' | 'snapshot'
  includeThinking: boolean
  includeTools: boolean
  createdAt: string
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
  | { kind: 'tool'; toolUseId: string; name: string; input: string; result?: string; isError?: boolean; searchResults?: Array<{ title: string; url: string; description: string }>; searchHistoryResults?: Array<{ kind: 'chat' | 'file'; id: string; title: string; reason: string; projectId?: string }>; screenshotUrls?: string[] }
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
  researchDepth?: string
  // Convenience: a text step's content for the legacy Message.content access pattern
  // (kept so callers that only need the text can still work; derived from steps on load)
  content?: string
  // Sibling navigation metadata (Inc 4)
  siblingIndex?: number
  siblingCount?: number
  siblings?: string[]
  // Set on assistant bubbles that ended due to a stream error (partial answer)
  errored?: boolean
  // Set on assistant bubbles that hit the round-budget ceiling — a complete answer, just
  // budget-limited (distinct from errored). See docs/adr/0020-research-depth-and-budget-pacing.md.
  truncated?: boolean
}

export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high' | 'max'

export interface ModelCapabilities {
  provider: 'bedrock-converse' | 'bedrock-responses'
  thinking: 'adaptive' | 'effort' | 'none'
  thinkingLevels?: ThinkingEffort[]
  attachments: boolean
  documents: boolean
  promptCaching: 'auto' | 'explicit' | 'none'
  region?: string
  maxOutputTokens?: number
}

export interface ModelSettings {
  thinkingEffort?: ThinkingEffort
  webSearchEnabled?: boolean
  webSearchProvider?: 'jina' | 'agentcore'
  browserCoreEnabled?: boolean
  browserExtendedEnabled?: boolean
  memoryEnabled?: boolean
  searchEnabled?: boolean
  imageGenerationEnabled?: boolean
  answerLength?: 'default' | 'short' | 'extensive'
  injectCurrentDate?: boolean
  showTokenStats?: boolean
  researchDepth?: ResearchDepth
}

export const RESEARCH_DEPTHS = ['brief', 'extended', 'deep'] as const
export type ResearchDepth = typeof RESEARCH_DEPTHS[number]

export interface UserMemory {
  memId: string
  text: string
  category: 'identity' | 'preference' | 'style' | 'other'
  createdAt: string
  updatedAt: string
}

export interface ProjectMemory {
  userEdited?: boolean
  sourceChatId?: string
  memId: string
  text: string
  category: 'decision' | 'convention' | 'fact' | 'constraint' | 'glossary' | 'other'
  createdAt: string
  updatedAt: string
}

export interface ProjectFile {
  url?: string
  errorMessage?: string
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
  showTokenStats?: boolean
  researchDepth?: ResearchDepth
}

export interface Model {
  id: string
  name: string
  capabilities: ModelCapabilities
}

export const THINKING_EFFORTS = ['off', 'low', 'medium', 'high', 'max'] as const

export function defaultSettings(caps: ModelCapabilities): ModelSettings {
  const defaultEffort: ThinkingEffort = (!caps.thinkingLevels || caps.thinkingLevels.includes('low'))
    ? 'low'
    : (caps.thinkingLevels[0] ?? 'low')
  return {
    ...(caps.thinking !== 'none' ? { thinkingEffort: defaultEffort } : {}),
    webSearchEnabled: true,
    browserCoreEnabled: true,
    browserExtendedEnabled: false,
  }
}

// Keep the composer's thinking-effort choice across a model switch when the new model offers
// that level; otherwise drop it so the picker falls back to the chat's saved value.
export function carryThinkingEffort(effort: ThinkingEffort | null, caps: ModelCapabilities): ThinkingEffort | null {
  if (!effort || caps.thinking === 'none') return null
  return !caps.thinkingLevels || caps.thinkingLevels.includes(effort) ? effort : null
}

// Carry over settings that are valid for the new model; fill missing with defaults
export function migrateSettings(prev: ModelSettings, caps: ModelCapabilities): ModelSettings {
  const defaults = defaultSettings(caps)
  // Pre-split-toggle settings only had a single `browserToolEnabled` (the old name for what
  // is now the scripted/Extended tool); carry an explicit `true` forward as Extended, but
  // Core always defaults on regardless of the old flag's value.
  const legacyBrowserToolEnabled = (prev as { browserToolEnabled?: boolean }).browserToolEnabled
  return {
    ...(caps.thinking !== 'none'
      ? {
          thinkingEffort: (prev.thinkingEffort && (!caps.thinkingLevels || caps.thinkingLevels.includes(prev.thinkingEffort)))
            ? prev.thinkingEffort
            : defaults.thinkingEffort,
        }
      : {}),
    webSearchEnabled: prev.webSearchEnabled ?? true,
    browserCoreEnabled: prev.browserCoreEnabled ?? true,
    browserExtendedEnabled: prev.browserExtendedEnabled ?? legacyBrowserToolEnabled ?? false,
    memoryEnabled: prev.memoryEnabled ?? true,
    searchEnabled: prev.searchEnabled ?? true,
    // Opt-in (unlike the other tools above) — costs money per call, so carry the user's
    // choice forward rather than defaulting it on.
    ...(prev.imageGenerationEnabled !== undefined ? { imageGenerationEnabled: prev.imageGenerationEnabled } : {}),
    ...(prev.showTokenStats !== undefined ? { showTokenStats: prev.showTokenStats } : {}),
  }
}

export const api = {
  listChats: ()                        => req<{ chats: Chat[] }>('GET', '/api/chats'),
  getChat: (chatId: string)            => req<Chat>('GET', `/api/chats/${chatId}`),
  createChat: (model: string, systemPrompt: string, chatId?: string, modelSettings?: ModelSettings, projectId?: string, flags?: { sensitive?: boolean; ephemeral?: boolean }) =>
    req<{ chatId: string }>('POST', '/api/chats', {
      model, systemPrompt,
      ...(chatId ? { chatId } : {}),
      ...(modelSettings ? { modelSettings } : {}),
      ...(projectId ? { projectId } : {}),
      ...(flags?.sensitive ? { sensitive: true } : {}),
      ...(flags?.ephemeral ? { ephemeral: true } : {}),
    }),
  renameChat: (chatId: string, title: string) =>
    req<void>('PATCH', `/api/chats/${chatId}`, { title }),
  updateSystemPrompt: (chatId: string, systemPrompt: string) =>
    req<void>('PATCH', `/api/chats/${chatId}`, { systemPrompt }),
  updateChatSettings: (chatId: string, settings: ModelSettings) =>
    req<void>('PATCH', `/api/chats/${chatId}`, { modelSettings: settings }),
  updateChatFlags: (chatId: string, flags: { sensitive?: boolean; ephemeral?: boolean }) =>
    req<void>('PATCH', `/api/chats/${chatId}`, flags),
  deleteChat: (chatId: string)         => req<void>('DELETE', `/api/chats/${chatId}`),
  // Paginated: defaults to the most recent page. Pass `before` (the previous page's
  // `oldestMsgId`) to fetch the page immediately before it, for scroll-up loading of
  // older history.
  listMessages: (chatId: string, opts?: { limit?: number; before?: string }) => {
    const params = new URLSearchParams()
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.before) params.set('before', opts.before)
    const qs = params.toString()
    // `streaming`: the backend is generating an answer for this chat right now, possibly for
    // a connection that is no longer ours — what ChatView polls on after a dropped socket.
    // `streamingDeadlineAt`: present only while a deep turn is streaming — drives the countdown.
    return req<{ bubbles: Message[]; conversationUsage: TokenUsage; hasMore: boolean; oldestMsgId: string | null; streaming: boolean; streamingDeadlineAt?: number }>(
      'GET', `/api/chats/${chatId}/messages${qs ? `?${qs}` : ''}`)
  },
  setActiveLeaf: (chatId: string, activeLeafId: string) => req<void>('PATCH', `/api/chats/${chatId}`, { activeLeafId }),
  listModels: ()                       => req<{ models: Model[] }>('GET', '/api/models'),
  retitleChat: (chatId: string)        => req<{ title: string }>('POST', `/api/chats/${chatId}/retitle`),
  resummarizeChat: (chatId: string)    => req<{ summary: string; topics: string[] }>('POST', `/api/chats/${chatId}/resummarize`),
  forkChat: (chatId: string, fromMsgId: string) =>
    req<{ chatId: string }>('POST', `/api/chats/${chatId}/fork`, { fromMsgId }),
  deleteBranch: (chatId: string, msgId: string) =>
    req<void>('DELETE', `/api/chats/${chatId}/messages/${msgId}`),
  getPreferences: ()                         => req<{ preferences: UserPreferences }>('GET', '/api/preferences'),
  savePreferences: (prefs: UserPreferences)  => req<{ ok: boolean }>('PUT', '/api/preferences', prefs),
  listMemory: ()                             => req<{ memories: UserMemory[] }>('GET', '/api/memory'),
  deleteMemory: (memId: string)              => req<void>('DELETE', `/api/memory/${memId}`),
  updateMemory: (memId: string, fields: Partial<Pick<UserMemory, 'text' | 'category'>>) =>
    req<{ ok: boolean }>('PATCH', `/api/memory/${memId}`, fields),
  listProjects: () => req<{ projects: Project[] }>('GET', '/api/projects'),
  createProject: (name: string) => req<{ projectId: string }>('POST', '/api/projects', { name }),
  getProject: (projectId: string) => req<{ project: Project; chats: Chat[] }>('GET', `/api/projects/${projectId}`),
  updateProject: (projectId: string, fields: Partial<Pick<Project, 'name' | 'description' | 'instructions' | 'memoryEnabled' | 'modelSettings'>> & { defaultModel?: string | null }) =>
    req<{ ok: boolean }>('PATCH', `/api/projects/${projectId}`, fields),
  createProjectMemory: (projectId: string, text: string) => req<{ memId: string }>('POST', `/api/projects/${projectId}/memory`, { text, category: 'fact' }),
  deleteProject: (projectId: string) => req<void>('DELETE', `/api/projects/${projectId}`),
  moveChatToProject: (chatId: string, projectId: string | null) =>
    req<void>('PATCH', `/api/chats/${chatId}`, { projectId }),
  listProjectMemory: (projectId: string) =>
    req<{ memories: ProjectMemory[] }>('GET', `/api/projects/${projectId}/memory`),
  updateProjectMemory: (projectId: string, memId: string, fields: Partial<Pick<ProjectMemory, 'text' | 'category'>>) =>
    req<{ ok: boolean }>('PATCH', `/api/projects/${projectId}/memory/${memId}`, fields),
  deleteProjectMemory: (projectId: string, memId: string) =>
    req<void>('DELETE', `/api/projects/${projectId}/memory/${memId}`),
  listProjectFiles: (projectId: string) =>
    req<{ files: ProjectFile[] }>('GET', `/api/projects/${projectId}/files`),
  requestProjectFileUpload: (projectId: string, filename: string, contentType: string, sizeBytes: number) =>
    req<{ fileId: string; s3Key: string; uploadUrl: string }>('POST', `/api/projects/${projectId}/files`, { filename, contentType, sizeBytes }),
  finalizeProjectFile: (projectId: string, fileId: string) =>
    req<{ file: ProjectFile }>('PUT', `/api/projects/${projectId}/files/${fileId}`),
  updateProjectFile: (projectId: string, fileId: string, fields: Partial<Pick<ProjectFile, 'inclusion' | 'summary' | 'microLabel'>>) =>
    req<{ ok: boolean }>('PATCH', `/api/projects/${projectId}/files/${fileId}`, fields),
  deleteProjectFile: (projectId: string, fileId: string) =>
    req<void>('DELETE', `/api/projects/${projectId}/files/${fileId}`),
  updateChatSummary: (chatId: string, fields: Partial<Pick<Chat, 'summary' | 'topics'>>) =>
    req<void>('PATCH', `/api/chats/${chatId}`, fields),
  createShare: (chatId: string, opts: { mode: 'live' | 'snapshot'; includeThinking: boolean; includeTools: boolean }) =>
    req<Share>('POST', `/api/chats/${chatId}/shares`, opts),
  listShares: (chatId: string) => req<{ shares: Share[] }>('GET', `/api/chats/${chatId}/shares`),
  deleteShare: (chatId: string, shareId: string) =>
    req<void>('DELETE', `/api/chats/${chatId}/shares/${shareId}`),
}

// Not part of the `api` object above since it returns raw Markdown text (Content-Disposition
// download), not a JSON body — req() always calls res.json(). Authenticated like every other
// /api/* call (bearer header); this is the OWNER's private export and is intentionally distinct
// from the public /s/{shareId} link, where the ULID itself is the credential (see
// backend/CLAUDE.md "Chat sharing" for why the two must not share an auth model).
export async function exportChat(chatId: string, opts: { includeThinking: boolean; includeTools: boolean }): Promise<string> {
  const params = new URLSearchParams({
    includeThinking: String(opts.includeThinking),
    includeTools: String(opts.includeTools),
  })
  const res = await fetch(`${ENV.apiBaseUrl}/api/chats/${chatId}/export?${params}`, {
    headers: { Authorization: `Bearer ${_accessToken}` },
  })
  if (!res.ok) throw new Error(await res.text().catch(() => String(res.status)))
  return res.text()
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

// Presigned direct-to-S3 PUT — see docs/adr/0011-presigned-s3-direct-put-uploads.md.
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
