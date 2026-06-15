import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Chat, Message, Model, ModelSettings, Step, TokenUsage, UserPreferences } from '../api/http'
import { parseSearchResults } from '../lib/toolResults'
export type { Step, TokenUsage, UserPreferences } from '../api/http'

// A tool step that may be in progress (no result yet)
export type ToolStep = Extract<Step, { kind: 'tool' }>

// StreamingMsg is the live assembly area during an active response.
// steps[] is ordered in arrival order — exactly the same order as DisplayBubble.steps.
export interface StreamingMsg {
  role: 'assistant'
  steps: Step[]
  usage?: TokenUsage
  streaming: true
  waiting?: boolean  // true until first content event arrives
  idle?: boolean     // true after 2s of no content events (inter-turn gap)
}

export type ToastKind = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  kind: ToastKind
  text: string
}

let _toastSeq = 0

export type ActivePanel = 'chats' | 'memory' | 'prefs'

interface ChatState {
  chats: Chat[]
  activeChatId: string | null
  messages: Message[]
  streamingMsg: StreamingMsg | null
  models: Model[]
  loading: boolean
  sending: boolean
  lastModel: string
  sidebarWidth: number
  activePanel: ActivePanel
  userPreferences: UserPreferences
  toasts: Toast[]

  setChats: (chats: Chat[]) => void
  addChat: (chat: Chat) => void
  removeChat: (chatId: string) => void
  renameChat: (chatId: string, title: string) => void
  updateChatSystemPrompt: (chatId: string, systemPrompt: string) => void
  setActiveChat: (chatId: string | null) => void
  setMessages: (messages: Message[]) => void
  pushToast: (toast: Omit<Toast, 'id'>) => void
  dismissToast: (id: number) => void
  startStream: () => void
  /** Append text to the last text step; create a new text step if needed */
  appendDelta: (text: string) => void
  /** Append text to the last thinking step; create a new thinking step if needed */
  appendThinkingDelta: (text: string) => void
  /** Mark the current thinking step as done (subsequent deltas start a new step) */
  markThinkingDone: () => void
  /** Push a new pending tool step */
  addToolCall: (tc: { toolUseId: string; name: string; input: string }) => void
  /** Set the JSON input on a tool step */
  updateToolCallInput: (toolUseId: string, input: string) => void
  /** Attach tool result to the matching tool step */
  resolveToolCall: (toolUseId: string, result: string, isError: boolean) => void
  /** Set live usage stats from the 'usage' WS event */
  setStreamUsage: (usage: TokenUsage) => void
  /** Toggle idle indicator — churn-free: no-op when value unchanged */
  setStreamIdle: (idle: boolean) => void
  /** Move streamingMsg to messages[] as a DisplayBubble */
  finalizeStream: () => void
  clearStream: () => void
  setModels: (models: Model[]) => void
  setLoading: (v: boolean) => void
  setSending: (v: boolean) => void
  setLastModel: (modelId: string) => void
  setSidebarWidth: (w: number) => void
  setActivePanel: (panel: ActivePanel) => void
  setUserPreferences: (p: UserPreferences) => void
  memoryRefreshTick: number
  triggerMemoryRefresh: () => void

  currentChatId: string | null
  draftModelSettings: ModelSettings
  draftSystemPrompt: string
  setCurrentChatId: (id: string | null) => void
  setDraftModelSettings: (s: ModelSettings) => void
  setDraftSystemPrompt: (p: string) => void
  updateChatSettings: (chatId: string, settings: ModelSettings) => void
}

// ── Internal step-mutation helpers (pure, no React state) ─────────────────────

// Returns the last step if it matches the given kind and is "open" (modifiable)
function lastOpenStep<K extends Step['kind']>(steps: Step[], kind: K): (Extract<Step, { kind: K }> & { _open?: true }) | null {
  if (steps.length === 0) return null
  const last = steps[steps.length - 1]
  if (last.kind !== kind) return null
  // A tool step is never "open" for text appending after it's been pushed
  if (kind === 'tool') return null
  return last as Extract<Step, { kind: K }> & { _open?: true }
}

function appendToLastThinking(steps: Step[], text: string): Step[] {
  if (steps.length > 0) {
    const last = steps[steps.length - 1] as Step & { _done?: boolean }
    if (last.kind === 'thinking' && !last._done) {
      return [
        ...steps.slice(0, -1),
        { ...last, text: last.text + text },
      ]
    }
  }
  return [...steps, { kind: 'thinking', text }]
}

function appendToLastText(steps: Step[], text: string): Step[] {
  const last = lastOpenStep(steps, 'text')
  if (last) {
    return [
      ...steps.slice(0, -1),
      { ...last, text: last.text + text },
    ]
  }
  return [...steps, { kind: 'text', text }]
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      chats: [],
      activeChatId: null,
      messages: [],
      streamingMsg: null,
      models: [],
      loading: false,
      sending: false,
      lastModel: '',
      sidebarWidth: 260,
      activePanel: 'chats',
      userPreferences: {},
      toasts: [],
      memoryRefreshTick: 0,

      currentChatId: null,
      draftModelSettings: {},
      draftSystemPrompt: '',

      setChats: (chats) => set({ chats }),
      addChat: (chat) => set((s) => ({ chats: [chat, ...s.chats] })),
      removeChat: (chatId) => set((s) => ({
        chats: s.chats.filter(c => c.chatId !== chatId),
        activeChatId: s.activeChatId === chatId ? null : s.activeChatId,
        messages: s.activeChatId === chatId ? [] : s.messages,
      })),
      renameChat: (chatId, title) => set((s) => ({
        chats: s.chats.map(c => c.chatId === chatId ? { ...c, title } : c),
      })),
      updateChatSystemPrompt: (chatId, systemPrompt) => set((s) => ({
        chats: s.chats.map(c => c.chatId === chatId ? { ...c, systemPrompt } : c),
      })),
      setActiveChat: (chatId) => set({ activeChatId: chatId, messages: [], streamingMsg: null }),
      setMessages: (messages) => set({ messages }),

      startStream: () => set({
        streamingMsg: { role: 'assistant', streaming: true, steps: [], waiting: true },
      }),

      appendDelta: (text) => set((s) => {
        const sm = s.streamingMsg ?? { role: 'assistant' as const, streaming: true as const, steps: [] }
        return {
          streamingMsg: {
            ...sm,
            steps: appendToLastText(sm.steps, text),
            waiting: false,
          } as StreamingMsg,
        }
      }),

      appendThinkingDelta: (text) => set((s) => {
        const sm = s.streamingMsg ?? { role: 'assistant' as const, streaming: true as const, steps: [] }
        return {
          streamingMsg: {
            ...sm,
            steps: appendToLastThinking(sm.steps, text),
            waiting: false,
          } as StreamingMsg,
        }
      }),

      markThinkingDone: () => set((s) => {
        if (!s.streamingMsg) return {}
        const steps = s.streamingMsg.steps
        if (steps.length === 0 || steps[steps.length - 1].kind !== 'thinking') return {}
        // Mark the last thinking step as done so subsequent thinking_delta events
        // start a new thinking step (appendToLastThinking checks _done).
        const lastStep = steps[steps.length - 1] as Step & { _done?: boolean }
        return {
          streamingMsg: {
            ...s.streamingMsg,
            steps: [
              ...steps.slice(0, -1),
              { ...lastStep, _done: true },
            ],
          } as StreamingMsg,
        }
      }),

      addToolCall: (tc) => set((s) => {
        const sm = s.streamingMsg ?? { role: 'assistant' as const, streaming: true as const, steps: [] }
        const toolStep: Step = { kind: 'tool', toolUseId: tc.toolUseId, name: tc.name, input: tc.input }
        return {
          streamingMsg: {
            ...sm,
            steps: [...sm.steps, toolStep],
            waiting: false,
          } as StreamingMsg,
        }
      }),

      updateToolCallInput: (toolUseId, input) => set((s) => {
        if (!s.streamingMsg) return {}
        return {
          streamingMsg: {
            ...s.streamingMsg,
            steps: s.streamingMsg.steps.map(step =>
              step.kind === 'tool' && step.toolUseId === toolUseId
                ? { ...step, input }
                : step
            ),
          } as StreamingMsg,
        }
      }),

      resolveToolCall: (toolUseId, result, isError) => set((s) => {
        if (!s.streamingMsg) return {}
        return {
          streamingMsg: {
            ...s.streamingMsg,
            steps: s.streamingMsg.steps.map(step => {
              if (step.kind !== 'tool' || step.toolUseId !== toolUseId) return step
              const searchResults = parseSearchResults(step.name, result, isError)
              return { ...step, result, isError, searchResults }
            }),
          } as StreamingMsg,
        }
      }),

      setStreamUsage: (usage) => set((s) => ({
        streamingMsg: s.streamingMsg
          ? { ...s.streamingMsg, usage }
          : null,
      })),

      setStreamIdle: (idle) => set((s) => {
        if (!s.streamingMsg || (s.streamingMsg.idle ?? false) === idle) return {}
        return { streamingMsg: { ...s.streamingMsg, idle } }
      }),

      finalizeStream: () => set((s) => {
        if (!s.streamingMsg) return {}
        // Strip internal `_done` sentinels from steps before persisting
        const cleanSteps = s.streamingMsg.steps.map(step => {
          const { _done, ...rest } = step as Step & { _done?: boolean }
          void _done
          return rest as Step
        })
        return {
          messages: [
            ...s.messages,
            {
              msgId: crypto.randomUUID(),
              role: 'assistant' as const,
              steps: cleanSteps,
              model: '',
              createdAt: new Date().toISOString(),
              usage: s.streamingMsg.usage,
            } satisfies Message,
          ],
          streamingMsg: null,
        }
      }),

      pushToast: (toast) => set((s) => ({ toasts: [...s.toasts, { ...toast, id: ++_toastSeq }] })),
      dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter(t => t.id !== id) })),

      clearStream: () => set({ streamingMsg: null }),
      setModels: (models) => set({ models }),
      setLoading: (loading) => set({ loading }),
      setSending: (sending) => set({ sending }),
      setLastModel: (lastModel) => set({ lastModel }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      setActivePanel: (activePanel) => set({ activePanel }),
      setUserPreferences: (userPreferences) => set({ userPreferences }),
      triggerMemoryRefresh: () => set((s) => ({ memoryRefreshTick: s.memoryRefreshTick + 1 })),

      setCurrentChatId: (id) => set({ currentChatId: id }),
      setDraftModelSettings: (s) => set({ draftModelSettings: s }),
      setDraftSystemPrompt: (p) => set({ draftSystemPrompt: p }),
      updateChatSettings: (chatId, settings) => set((s) => ({
        chats: s.chats.map(c => c.chatId === chatId ? { ...c, modelSettings: settings } : c),
      })),
    }),
    {
      name: 'chatrock-store',
      partialize: (s) => ({ lastModel: s.lastModel, sidebarWidth: s.sidebarWidth, activePanel: s.activePanel, userPreferences: s.userPreferences }),
    }
  )
)
