import { ENV } from '../env'
import type { ModelSettings, TokenUsage } from './http'

// Same shape whether the write came from an explicit manage_memory/manage_project_memory
// tool call (one item) or passive post-turn enrichment (zero or more) — see
// docs/adr/0013-memory-update-detail-and-editing.md.
export interface MemoryUpdateItem {
  scope: 'user' | 'project'
  op: string
  category?: string
  text?: string
}

// Every frame is stamped with the chatId it belongs to (backend/src/ws/sendMessage.ts's
// safePost) so a client streaming more than one chat at once can route each frame to the
// right per-chat slot instead of assuming "the chat currently in view". See
// docs/adr/0040-concurrent-per-chat-streaming.md.
export type WSEvent = (
  // deadlineAt (epoch ms) is present only for a deep turn — see backend/src/ws/sendMessage.ts.
  | { type: 'ack'; deadlineAt?: number }
  | { type: 'delta';          text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_done' }
  | { type: 'tool_call_start'; toolUseId: string; name: string }
  | { type: 'tool_call';      toolUseId: string; name: string; input: string }
  | { type: 'tool_result';    toolUseId: string; name: string; isError: boolean; content?: string; screenshotUrls?: string[] }
  | { type: 'usage';          usage: TokenUsage }
  | { type: 'done';           stopReason: string }
  | { type: 'cancelled' }
  | { type: 'titleUpdated';   chatId: string; title: string }
  | { type: 'memoryUpdated';  count: number; items?: MemoryUpdateItem[] }
  | { type: 'error';          message: string; responseId?: string; leafId?: string }
  | { type: 'warning';        message: string }
  | { type: 'heartbeat' }
  // Narration from a run_research_task sub-agent, tagged with the parent tool call's
  // toolUseId. Purely UI feedback — dropped frames cost nothing, since the finding itself
  // is persisted as the tool result. See docs/adr/0039-deep-research-as-a-sub-agent-tool.md.
  | { type: 'sub_agent_progress'; toolUseId: string; name: string; text: string }
) & { chatId: string }

type EventHandler = (evt: WSEvent) => void
// 'unauthorized' is the give-up state: repeated $connect failures, which in practice means
// an access token the authorizer rejects. Distinct from 'connecting' so the UI can offer a
// button instead of a spinner that would never stop.
export type ConnectionState = 'open' | 'connecting' | 'closed' | 'unauthorized'

// Reconnect must never reuse a token captured at first connect: Cognito access tokens live
// 60 minutes, and a phone that sleeps through the expiry would otherwise retry a dead token
// forever. The provider renews on demand — see docs/adr/0036-websocket-reads-the-token-late.md.
type TokenProvider = () => Promise<string>

const MAX_RECONNECT_ATTEMPTS = 5

let socket: WebSocket | null = null
let onEventCb: EventHandler | null = null
let onConnectionStateCb: ((state: ConnectionState) => void) | null = null
let tokenProvider: TokenProvider | null = null
let explicitDisconnect = false
// Set by the caller (ChatView, mirroring its `sending` flag) so onclose knows whether a
// drop is worth chasing. Kept out of the store to avoid ws.ts <-> chatStore coupling.
let turnInFlight = false
let reconnectAttempt = 0
let reconnectTimer: number | null = null

export function setWSHandlers(onEvent: EventHandler) {
  onEventCb = onEvent
}

export function setConnectionStateHandler(onState: (state: ConnectionState) => void) {
  onConnectionStateCb = onState
}

export function setTurnInFlight(active: boolean) {
  turnInFlight = active
}

export function setTokenProvider(provider: TokenProvider) {
  tokenProvider = provider
}

export async function connect(): Promise<void> {
  explicitDisconnect = false
  if (socket && socket.readyState === WebSocket.OPEN) return
  if (!tokenProvider) throw new Error('WebSocket token provider not set')
  onConnectionStateCb?.('connecting')
  // Read the token here, per connect — not once at startup.
  const accessToken = await tokenProvider()
  return new Promise((resolve, reject) => {
    let attempts = 0
    const MAX_ATTEMPTS = 3

    const attempt = () => {
      attempts++
      const ws = new WebSocket(`${ENV.wsUrl}?token=${encodeURIComponent(accessToken)}`)

      ws.onopen = () => {
        socket = ws
        reconnectAttempt = 0
        onConnectionStateCb?.('open')
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
        // Backgrounding the tab (iOS in particular) drops the socket outright. Chase it
        // only while a turn is in flight — an idle drop can reconnect lazily on next send.
        if (!explicitDisconnect && turnInFlight) {
          scheduleReconnect()
        } else {
          onConnectionStateCb?.('closed')
        }
      }
    }

    attempt()
  })
}

function scheduleReconnect() {
  if (reconnectTimer !== null || !tokenProvider) return
  // A handshake rejected by the authorizer is indistinguishable from a network failure in
  // the browser (no status code reaches JS), so failures are counted rather than classified:
  // past the cap, stop and hand the user a Reconnect button.
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    onConnectionStateCb?.('unauthorized')
    return
  }
  onConnectionStateCb?.('connecting')
  const delay = Math.min(1000 * 2 ** reconnectAttempt, 10000)
  reconnectAttempt++
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    if (explicitDisconnect) return
    connect().catch(() => {})
  }, delay)
}

// The Reconnect button's action: clears the give-up state and starts over with a freshly
// fetched (renewed if needed) token.
export function reconnectNow(): Promise<void> {
  reconnectAttempt = 0
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  return connect()
}

export function disconnect() {
  explicitDisconnect = true
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  socket?.close()
  socket = null
  onConnectionStateCb?.('closed')
}

// Shared attachment wire shape for sendMessage — mirrors
// backend/src/lib/attachments.ts's AttachmentMeta.
export interface WSAttachment {
  s3Key: string
  contentType: string
  filename: string
  mode?: 'standard' | 'rich'
}

export function sendMessage(payload: {
  chatId: string
  content?: string
  model: string
  systemPrompt: string
  modelSettings?: ModelSettings
  parentId?: string | null
  continue?: boolean
  attachments?: WSAttachment[]
  // Explicit Search entry (header search box) — forces the search_history tool on this turn.
  // See backend/src/ws/sendMessage.ts's WS payload contract.
  search?: { scope: 'project' | 'global' }
}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket not connected')
  }
  socket.send(JSON.stringify({ action: 'sendMessage', ...payload }))
}

export function cancelMessage(chatId: string) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ action: 'cancelMessage', chatId }))
}

export function isConnected() {
  return socket !== null && socket.readyState === WebSocket.OPEN
}

export async function ensureConnected() {
  if (!isConnected()) {
    await connect()
  }
}
