import { ENV } from '../env'
import type { ModelSettings, TokenUsage } from './http'

export type WSEvent =
  | { type: 'delta';          text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_done' }
  | { type: 'tool_call_start'; toolUseId: string; name: string }
  | { type: 'tool_call';      toolUseId: string; name: string; input: string }
  | { type: 'tool_result';    toolUseId: string; name: string; isError: boolean; content?: string }
  | { type: 'usage';          usage: TokenUsage }
  | { type: 'done';           stopReason: string }
  | { type: 'cancelled' }
  | { type: 'titleUpdated';   chatId: string; title: string }
  | { type: 'error';          message: string }

type EventHandler = (evt: WSEvent) => void

let socket: WebSocket | null = null
let onEventCb: EventHandler | null = null

export function setWSHandlers(onEvent: EventHandler) {
  onEventCb = onEvent
}

export function connect(accessToken: string): Promise<void> {
  if (socket && socket.readyState === WebSocket.OPEN) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    socket = new WebSocket(`${ENV.wsUrl}?token=${encodeURIComponent(accessToken)}`)
    socket.onopen  = () => resolve()
    socket.onerror = () => reject(new Error('WebSocket connect failed'))
    socket.onmessage = (ev) => {
      try {
        const data: WSEvent = JSON.parse(ev.data)
        onEventCb?.(data)
      } catch {
        // ignore malformed frames
      }
    }
    socket.onclose = () => {
      socket = null
    }
  })
}

export function disconnect() {
  socket?.close()
  socket = null
}

export function sendMessage(payload: {
  chatId: string
  content?: string
  model: string
  systemPrompt: string
  modelSettings?: ModelSettings
  parentId?: string | null
  attachments?: Array<{
    s3Key: string
    contentType: string
    filename: string
    mode?: 'standard' | 'rich'
  }>
}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket not connected')
  }
  socket.send(JSON.stringify({ action: 'sendMessage', ...payload }))
}

export function cancelMessage() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ action: 'cancelMessage' }))
}

export function isConnected() {
  return socket !== null && socket.readyState === WebSocket.OPEN
}

export async function ensureConnected(accessToken: string) {
  if (!isConnected()) {
    await connect(accessToken)
  }
}
