import { ENV } from '../env'
import type { ModelSettings, Step, TokenUsage } from './http'

// Same shape whether the write came from an explicit manage_memory/manage_project_memory
// tool call (one item) or passive post-turn enrichment (zero or more) — see
// docs/adr/0013-memory-update-detail-and-editing.md.
export interface MemoryUpdateItem {
  scope: 'user' | 'project'
  op: string
  category?: string
  text?: string
}

// Mirrors backend/src/research/types.ts's ResearchPhase — the phases that run a single
// blocking model call and so have no steps to report, plus recon's own announcement.
export type ResearchPhase = 'recon' | 'planning' | 'assessing' | 'reporting' | 'dossier'

export type WSEvent =
  | { type: 'ack' }
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
  // Deep Research progress frames — see backend/src/research/CLAUDE.md's "Progress
  // frames and reconnect". Best-effort; GET /api/chats/{chatId}/research re-syncs.
  // msgId is the assistant turn the plan was persisted as — awaitApproval.ts writes it before
  // sending this frame, so the client can just reload the transcript to show the plan.
  | { type: 'research_plan';       runId: string; chatId: string; msgId: string; plan: { subQuestions: { id: string; question: string }[]; clarifyingQuestions: string[] } }
  | { type: 'research_wave_start'; runId: string; chatId: string; subQuestions: { id: string; question: string }[] }
  | { type: 'research_finding';    runId: string; chatId: string; subQuestionId: string; summary: string; sourceUrls: string[] }
  | { type: 'research_assess';     runId: string; chatId: string; findingCount: number; done: boolean }
  // Live progress from the phases that run a real converseStream loop (recon, each
  // researcher) plus a coarse phase signal for the blocking converseOnce phases —
  // see backend/src/research/progress.ts.
  | { type: 'research_phase';      runId: string; chatId: string; phase: ResearchPhase; detail?: string }
  | { type: 'research_step';       runId: string; chatId: string; subQuestionId?: string; step: Step }
  | { type: 'research_done';       runId: string; chatId: string; msgId: string }
  // Terminal failure — a state crashed or timed out and the run is over. Unlike every other
  // frame here this one is not merely a UI convenience: without it the panel spins on a run
  // that no longer exists. Its durable counterpart is the row's own status/failureReason.
  | { type: 'research_failed';     runId: string; chatId: string; message: string }
  // Mid-flight steering ack — see ws/sendMessage.ts's active-run interception.
  | { type: 'research_steering_noted'; runId: string; msgId: string }
  // A composer message that answered the plan-approval gate instead of becoming a
  // steering note — the backend classified it and already acted on it.
  | { type: 'research_plan_decision'; runId: string; chatId: string; msgId: string; decision: 'approve' | 'revise' }

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

// Shared attachment wire shape for both sendMessage and startResearch — mirrors
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

export function cancelMessage() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ action: 'cancelMessage' }))
}

// Starts a Deep Research run — see backend/src/research/CLAUDE.md's "Invocation".
// Returns {runId} via the WS route's Lambda response, not a pushed frame; the caller
// awaits it like an HTTP call (see ChatView.tsx's handleSend deep-research branch).
export function startResearch(payload: { chatId: string; question: string; attachments?: WSAttachment[] }) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket not connected')
  }
  socket.send(JSON.stringify({ action: 'startResearch', ...payload }))
}

// Resolves the AwaitApproval task token — see "Plan approval gate" in
// backend/src/research/CLAUDE.md. No "reject" decision; only approve/revise. `decision`,
// not `action`, since the WS envelope's own `action: 'researchApprove'` is what API
// Gateway's route selection matches on.
export function researchApprove(payload: { chatId: string; runId: string; decision: 'approve' | 'revise'; feedback?: string }) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket not connected')
  }
  socket.send(JSON.stringify({ action: 'researchApprove', ...payload }))
}

export function isConnected() {
  return socket !== null && socket.readyState === WebSocket.OPEN
}

export async function ensureConnected() {
  if (!isConnected()) {
    await connect()
  }
}
