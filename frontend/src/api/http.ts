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
}

export interface Message {
  msgId: string
  role: 'user' | 'assistant'
  content: string
  model: string
  createdAt: string
}

export interface Model {
  id: string
  name: string
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
  listMessages: (chatId: string)       => req<{ messages: Message[] }>('GET', `/api/chats/${chatId}/messages`),
  listModels: ()                       => req<{ models: Model[] }>('GET', '/api/models'),
  retitleChat: (chatId: string)        => req<{ title: string }>('POST', `/api/chats/${chatId}/retitle`),
}
