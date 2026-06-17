import { ENV } from '../env'
import type { ModelSettings, TokenUsage } from './http'

export type WSEvent =
  | { type: 'ack' }
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
  | { type: 'memoryUpdated';  count: number }
  | { type: 'error';          message: string; responseId?: string; leafId?: string }
  | { type: 'warning';        message: string }

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
    let attempts = 0
    const MAX_ATTEMPTS = 3

    const attempt = () => {
      attempts++
      const ws = new WebSocket(`${ENV.wsUrl}?token=${encodeURIComponent(accessToken)}`)

      ws.onopen = () => {
        socket = ws
        resolve()
      }
      ws.onerror = () => {
        if (attempts < MAX_ATTEMPTS) {
          setTimeout(attempt, 1500)
        } else {
          reject(new Error('WebSocket connect failed'))
        }
      }
      ws.onmessage = (ev) => {
        try {
          const data: WSEvent = JSON.parse(ev.data)
          onEventCb?.(data)
        } catch {
          // ignore malformed frames
        }
      }
      // Only clear the module-level socket if it's still this specific instance,
      // so a concurrent reconnect attempt doesn't get wiped by a stale onclose.
      ws.onclose = () => {
        if (socket === ws) socket = null
      }
    }

    attempt()
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
  continue?: boolean
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
