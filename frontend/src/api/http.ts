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
  | { kind: 'tool'; toolUseId: string; name: string; input: string; result?: string; isError?: boolean; searchResults?: Array<{ title: string; url: string; description: string }> }

export interface Message {
  msgId: string
  parentId?: string | null
  role: 'user' | 'assistant'
  // Format C: steps[] is the canonical shape
  steps: Step[]
  model: string
  createdAt: string
  usage?: TokenUsage
  // Convenience: a text step's content for the legacy Message.content access pattern
  // (kept so callers that only need the text can still work; derived from steps on load)
  content?: string
  // Sibling navigation metadata (Inc 4)
  siblingIndex?: number
  siblingCount?: number
  siblings?: string[]
}

export interface ModelCapabilities {
  temperature: boolean
  topP: boolean
  topK: boolean
  thinking: 'adaptive' | 'none'
}

export interface ModelSettings {
  temperature?: number
  topP?: number
  topK?: number
  thinkingEffort?: 'off' | 'low' | 'medium' | 'high' | 'max'
}

export interface Model {
  id: string
  name: string
  capabilities: ModelCapabilities
}

export const THINKING_EFFORTS = ['off', 'low', 'medium', 'high', 'max'] as const

export function defaultSettings(caps: ModelCapabilities): ModelSettings {
  return {
    ...(caps.thinking !== 'none' ? { thinkingEffort: 'off' as const } : {}),
  }
}

// Carry over settings that are valid for the new model; fill missing with defaults
export function migrateSettings(prev: ModelSettings, caps: ModelCapabilities): ModelSettings {
  const defaults = defaultSettings(caps)
  return {
    ...(caps.temperature && prev.temperature !== undefined ? { temperature: prev.temperature } : {}),
    ...(caps.topP && prev.topP !== undefined ? { topP: prev.topP } : {}),
    ...(caps.topK && prev.topK !== undefined ? { topK: prev.topK } : {}),
    ...(caps.thinking !== 'none' ? { thinkingEffort: prev.thinkingEffort ?? defaults.thinkingEffort } : {}),
  }
}

export const api = {
  listChats: ()                        => req<{ chats: Chat[] }>('GET', '/api/chats'),
  createChat: (model: string, systemPrompt: string) =>
    req<{ chatId: string }>('POST', '/api/chats', { model, systemPrompt }),
  renameChat: (chatId: string, title: string) =>
    req<void>('PATCH', `/api/chats/${chatId}`, { title }),
  updateSystemPrompt: (chatId: string, systemPrompt: string) =>
    req<void>('PATCH', `/api/chats/${chatId}`, { systemPrompt }),
  updateModel: (chatId: string, model: string) =>
    req<void>('PATCH', `/api/chats/${chatId}`, { model }),
  deleteChat: (chatId: string)         => req<void>('DELETE', `/api/chats/${chatId}`),
  listMessages: (chatId: string)       => req<{ bubbles: Message[]; conversationUsage: TokenUsage }>('GET', `/api/chats/${chatId}/messages`),
  setActiveLeaf: (chatId: string, activeLeafId: string) => req<void>('PATCH', `/api/chats/${chatId}`, { activeLeafId }),
  listModels: ()                       => req<{ models: Model[] }>('GET', '/api/models'),
  retitleChat: (chatId: string)        => req<{ title: string }>('POST', `/api/chats/${chatId}/retitle`),
  forkChat: (chatId: string, fromMsgId: string) =>
    req<{ chatId: string }>('POST', `/api/chats/${chatId}/fork`, { fromMsgId }),
}
