import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Chat, Message, Model, ModelSettings, Project, ProjectFile, Step, TokenUsage, UserPreferences } from '../api/http'
import type { MemoryUpdateItem } from '../api/ws'
import { parseSearchResults, parseSearchHistoryResults } from '../lib/toolResults'
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
  items?: MemoryUpdateItem[]
  // Optional in-app navigation path (e.g. a project the toast is announcing) — a plain
  // route string rather than a callback since toasts are Zustand state.
  linkTo?: string
  linkLabel?: string
}

let _toastSeq = 0

export type ActivePanel = 'chats' | 'memory' | 'prefs' | 'projects'

// In-memory (not persisted — resets on reload) per-chat cache of the last-loaded messages
// page(s), so switching back to a chat already viewed this session skips the network round
// trip entirely. Capped LRU so long sessions don't grow this unbounded.
export interface CachedChatMessages {
  messages: Message[]
  conversationUsage: TokenUsage | null
  hasMoreOlder: boolean
  oldestMsgId: string | null
}
const MESSAGES_CACHE_CAP = 20

// A Search submitted from the global header (see App.tsx) — consumed once by ChatView's
// /c/new mount effect, which issues the first send with `search: {scope}` and clears this.
// Not persisted (see partialize below): a stale pending search must never survive a reload.
export interface PendingSearch {
  query: string
  scope: 'project' | 'global'
  projectId?: string
}

interface ChatState {
  chats: Chat[]
  activeChatId: string | null
  messages: Message[]
  // Keyed by chatId so more than one chat can stream at once (B3) — see
  // docs/adr/0040-concurrent-per-chat-streaming.md.
  streamingByChat: Record<string, StreamingMsg>
  models: Model[]
  loading: boolean
  sendingByChat: Record<string, boolean>
  lastModel: string
  sidebarWidth: number
  sidebarSplit: number
  activePanel: ActivePanel
  userPreferences: UserPreferences
  toasts: Toast[]

  setChats: (chats: Chat[]) => void
  addChat: (chat: Chat) => void
  /** Merge PATCH'd fields (e.g. sensitive/ephemeral/expiresAt) into a chat already in the store. */
  patchChat: (chatId: string, fields: Partial<Chat>) => void
  /** Dismiss the one-time "this chat's model was migrated" notice for a chat. */
  clearModelMigrationNotice: (chatId: string) => void
  removeChat: (chatId: string) => void
  renameChat: (chatId: string, title: string) => void
  updateChatSystemPrompt: (chatId: string, systemPrompt: string) => void
  setActiveChat: (chatId: string | null) => void
  setMessages: (messages: Message[]) => void
  pushToast: (toast: Omit<Toast, 'id'>) => void
  dismissToast: (id: number) => void
  startStream: (chatId: string) => void
  /** Append text to the last text step; create a new text step if needed */
  appendDelta: (chatId: string, text: string) => void
  /** Append text to the last thinking step; create a new thinking step if needed */
  appendThinkingDelta: (chatId: string, text: string) => void
  /** Mark the current thinking step as done (subsequent deltas start a new step) */
  markThinkingDone: (chatId: string) => void
  /** Push a new pending tool step */
  addToolCall: (chatId: string, tc: { toolUseId: string; name: string; input: string }) => void
  /** Set the JSON input on a tool step */
  updateToolCallInput: (chatId: string, toolUseId: string, input: string) => void
  /** Attach tool result to the matching tool step */
  resolveToolCall: (chatId: string, toolUseId: string, result: string, isError: boolean, screenshotUrls?: string[]) => void
  /** Set live usage stats from the 'usage' WS event */
  setStreamUsage: (chatId: string, usage: TokenUsage) => void
  /** Toggle idle indicator — churn-free: no-op when value unchanged */
  setStreamIdle: (chatId: string, idle: boolean) => void
  /** Pop streamingByChat[chatId] into a finalized Message, or undefined if there was none */
  finalizeStream: (chatId: string) => Message | undefined
  /** Same as finalizeStream but tags the result as errored (partial answer from a stream error) */
  finalizeStreamErrored: (chatId: string) => Message | undefined
  clearStream: (chatId: string) => void
  setModels: (models: Model[]) => void
  setLoading: (v: boolean) => void
  setSending: (chatId: string, v: boolean) => void
  setLastModel: (modelId: string) => void
  setSidebarWidth: (w: number) => void
  setSidebarSplit: (ratio: number) => void
  setActivePanel: (panel: ActivePanel) => void
  setUserPreferences: (p: UserPreferences) => void
  memoryRefreshTick: number
  triggerMemoryRefresh: () => void
  newChatTick: number
  bumpNewChatTick: () => void
  newProjectTick: number
  bumpNewProjectTick: () => void

  currentChatId: string | null
  draftModelSettings: ModelSettings
  draftSystemPrompt: string
  setCurrentChatId: (id: string | null) => void
  setDraftModelSettings: (s: ModelSettings) => void
  setDraftSystemPrompt: (p: string) => void
  updateChatSettings: (chatId: string, settings: ModelSettings) => void

  projects: Project[]
  setProjects: (projects: Project[]) => void
  addProject: (project: Project) => void
  updateProject: (projectId: string, fields: Partial<Project>) => void
  removeProject: (projectId: string) => void
  updateChatProjectId: (chatId: string, projectId: string | null) => void

  projectFilesById: Record<string, ProjectFile>
  mergeProjectFiles: (files: ProjectFile[]) => void

  pendingSearch: PendingSearch | null
  setPendingSearch: (pf: PendingSearch | null) => void

  messagesCache: Record<string, CachedChatMessages>
  cacheOrder: string[]
  getMessagesCache: (chatId: string) => CachedChatMessages | undefined
  setMessagesCache: (chatId: string, data: CachedChatMessages) => void
  invalidateMessagesCache: (chatId: string) => void
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
    (set, get) => ({
      chats: [],
      activeChatId: null,
      messages: [],
      streamingByChat: {},
      models: [],
      loading: false,
      sendingByChat: {},
      lastModel: '',
      sidebarWidth: 260,
      sidebarSplit: 0.6,
      activePanel: 'chats',
      userPreferences: {},
      toasts: [],
      memoryRefreshTick: 0,
      newChatTick: 0,
      newProjectTick: 0,

      currentChatId: null,
      draftModelSettings: {},
      draftSystemPrompt: '',
      projects: [],
      projectFilesById: {},
      pendingSearch: null,
      messagesCache: {},
      cacheOrder: [],

      setChats: (chats) => set({ chats }),
      addChat: (chat) => set((s) => ({ chats: [chat, ...s.chats] })),
      patchChat: (chatId, fields) => set((s) => ({
        chats: s.chats.map(c => c.chatId === chatId ? { ...c, ...fields } : c),
      })),
      clearModelMigrationNotice: (chatId) => set((s) => ({
        chats: s.chats.map(c => c.chatId === chatId ? { ...c, modelMigratedFrom: undefined } : c),
      })),
      removeChat: (chatId) => set((s) => {
        const { [chatId]: _removed, ...messagesCache } = s.messagesCache
        const { [chatId]: _removedStream, ...streamingByChat } = s.streamingByChat
        const { [chatId]: _removedSending, ...sendingByChat } = s.sendingByChat
        void _removed
        void _removedStream
        void _removedSending
        return {
          chats: s.chats.filter(c => c.chatId !== chatId),
          activeChatId: s.activeChatId === chatId ? null : s.activeChatId,
          messages: s.activeChatId === chatId ? [] : s.messages,
          messagesCache,
          cacheOrder: s.cacheOrder.filter(id => id !== chatId),
          streamingByChat,
          sendingByChat,
        }
      }),
      renameChat: (chatId, title) => set((s) => ({
        chats: s.chats.map(c => c.chatId === chatId ? { ...c, title } : c),
      })),
      updateChatSystemPrompt: (chatId, systemPrompt) => set((s) => ({
        chats: s.chats.map(c => c.chatId === chatId ? { ...c, systemPrompt } : c),
      })),
      setActiveChat: (chatId) => set({ activeChatId: chatId, messages: [] }),
      setMessages: (messages) => set({ messages }),

      startStream: (chatId) => set((s) => ({
        streamingByChat: {
          ...s.streamingByChat,
          [chatId]: { role: 'assistant', streaming: true, steps: [], waiting: true },
        },
      })),

      appendDelta: (chatId, text) => set((s) => {
        const sm = s.streamingByChat[chatId] ?? { role: 'assistant' as const, streaming: true as const, steps: [] }
        return {
          streamingByChat: {
            ...s.streamingByChat,
            [chatId]: {
              ...sm,
              steps: appendToLastText(sm.steps, text),
              waiting: false,
            } as StreamingMsg,
          },
        }
      }),

      appendThinkingDelta: (chatId, text) => set((s) => {
        const sm = s.streamingByChat[chatId] ?? { role: 'assistant' as const, streaming: true as const, steps: [] }
        return {
          streamingByChat: {
            ...s.streamingByChat,
            [chatId]: {
              ...sm,
              steps: appendToLastThinking(sm.steps, text),
              waiting: false,
            } as StreamingMsg,
          },
        }
      }),

      markThinkingDone: (chatId) => set((s) => {
        const sm = s.streamingByChat[chatId]
        if (!sm) return {}
        const steps = sm.steps
        if (steps.length === 0 || steps[steps.length - 1].kind !== 'thinking') return {}
        // Mark the last thinking step as done so subsequent thinking_delta events
        // start a new thinking step (appendToLastThinking checks _done).
        const lastStep = steps[steps.length - 1] as Step & { _done?: boolean }
        return {
          streamingByChat: {
            ...s.streamingByChat,
            [chatId]: {
              ...sm,
              steps: [
                ...steps.slice(0, -1),
                { ...lastStep, _done: true },
              ],
            },
          },
        }
      }),

      addToolCall: (chatId, tc) => set((s) => {
        const sm = s.streamingByChat[chatId] ?? { role: 'assistant' as const, streaming: true as const, steps: [] }
        const toolStep: Step = { kind: 'tool', toolUseId: tc.toolUseId, name: tc.name, input: tc.input }
        return {
          streamingByChat: {
            ...s.streamingByChat,
            [chatId]: {
              ...sm,
              steps: [...sm.steps, toolStep],
              waiting: false,
            } as StreamingMsg,
          },
        }
      }),

      updateToolCallInput: (chatId, toolUseId, input) => set((s) => {
        const sm = s.streamingByChat[chatId]
        if (!sm) return {}
        return {
          streamingByChat: {
            ...s.streamingByChat,
            [chatId]: {
              ...sm,
              steps: sm.steps.map(step =>
                step.kind === 'tool' && step.toolUseId === toolUseId
                  ? { ...step, input }
                  : step
              ),
            },
          },
        }
      }),

      resolveToolCall: (chatId, toolUseId, result, isError, screenshotUrls) => set((s) => {
        const sm = s.streamingByChat[chatId]
        if (!sm) return {}
        return {
          streamingByChat: {
            ...s.streamingByChat,
            [chatId]: {
              ...sm,
              steps: sm.steps.map(step => {
                if (step.kind !== 'tool' || step.toolUseId !== toolUseId) return step
                const searchResults = parseSearchResults(step.name, result, isError)
                const searchHistoryResults = parseSearchHistoryResults(step.name, result, isError)
                return { ...step, result, isError, searchResults, searchHistoryResults, screenshotUrls }
              }),
            },
          },
        }
      }),

      setStreamUsage: (chatId, usage) => set((s) => {
        const sm = s.streamingByChat[chatId]
        if (!sm) return {}
        return { streamingByChat: { ...s.streamingByChat, [chatId]: { ...sm, usage } } }
      }),

      setStreamIdle: (chatId, idle) => set((s) => {
        const sm = s.streamingByChat[chatId]
        if (!sm || (sm.idle ?? false) === idle) return {}
        return { streamingByChat: { ...s.streamingByChat, [chatId]: { ...sm, idle } } }
      }),

      finalizeStream: (chatId) => {
        const sm = get().streamingByChat[chatId]
        if (!sm) return undefined
        // Strip internal `_done` sentinels from steps before persisting
        const cleanSteps = sm.steps.map(step => {
          const { _done, ...rest } = step as Step & { _done?: boolean }
          void _done
          return rest as Step
        })
        const msg: Message = {
          msgId: crypto.randomUUID(),
          role: 'assistant',
          steps: cleanSteps,
          model: '',
          createdAt: new Date().toISOString(),
          usage: sm.usage,
        }
        set((s) => {
          const { [chatId]: _removed, ...streamingByChat } = s.streamingByChat
          void _removed
          return { streamingByChat }
        })
        return msg
      },

      finalizeStreamErrored: (chatId) => {
        const sm = get().streamingByChat[chatId]
        if (!sm) return undefined
        // Same as finalizeStream but tags the resulting message as errored so
        // the Continue button can appear on the preserved partial bubble.
        const cleanSteps = sm.steps.map(step => {
          const { _done, ...rest } = step as Step & { _done?: boolean }
          void _done
          return rest as Step
        })
        const msg: Message = {
          msgId: crypto.randomUUID(),
          role: 'assistant',
          steps: cleanSteps,
          model: '',
          createdAt: new Date().toISOString(),
          usage: sm.usage,
          errored: true,
        }
        set((s) => {
          const { [chatId]: _removed, ...streamingByChat } = s.streamingByChat
          void _removed
          return { streamingByChat }
        })
        return msg
      },

      pushToast: (toast) => set((s) => ({ toasts: [...s.toasts, { ...toast, id: ++_toastSeq }] })),
      dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter(t => t.id !== id) })),

      clearStream: (chatId) => set((s) => {
        const { [chatId]: _removed, ...streamingByChat } = s.streamingByChat
        void _removed
        return { streamingByChat }
      }),
      setModels: (models) => set({ models }),
      setLoading: (loading) => set({ loading }),
      setSending: (chatId, sending) => set((s) => ({
        sendingByChat: sending
          ? { ...s.sendingByChat, [chatId]: true }
          : Object.fromEntries(Object.entries(s.sendingByChat).filter(([id]) => id !== chatId)),
      })),
      setLastModel: (lastModel) => set({ lastModel }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      setSidebarSplit: (sidebarSplit) => set({ sidebarSplit }),
      setActivePanel: (activePanel) => set({ activePanel }),
      setUserPreferences: (userPreferences) => set({ userPreferences }),
      triggerMemoryRefresh: () => set((s) => ({ memoryRefreshTick: s.memoryRefreshTick + 1 })),
      bumpNewChatTick: () => set((s) => ({ newChatTick: s.newChatTick + 1 })),
      bumpNewProjectTick: () => set((s) => ({ newProjectTick: s.newProjectTick + 1 })),

      setCurrentChatId: (id) => set({ currentChatId: id }),
      setDraftModelSettings: (s) => set({ draftModelSettings: s }),
      setDraftSystemPrompt: (p) => set({ draftSystemPrompt: p }),
      updateChatSettings: (chatId, settings) => set((s) => ({
        chats: s.chats.map(c => c.chatId === chatId ? { ...c, modelSettings: settings } : c),
      })),

      setProjects: (projects) => set({ projects }),
      // Prepend, not append: the projects list relies on backend ULID
      // ordering (newest-first) plus this for same-session creates — there's
      // no client-side sort layer for the project list itself (unlike chats).
      addProject: (project) => set((s) => ({ projects: [project, ...s.projects] })),
      updateProject: (projectId, fields) => set((s) => ({
        projects: s.projects.map(p => p.projectId === projectId ? { ...p, ...fields } : p),
      })),
      removeProject: (projectId) => set((s) => ({
        projects: s.projects.filter(p => p.projectId !== projectId),
      })),
      updateChatProjectId: (chatId, projectId) => set((s) => ({
        chats: s.chats.map(c => c.chatId === chatId ? { ...c, projectId: projectId ?? undefined } : c),
      })),
      mergeProjectFiles: (files) => set((s) => ({
        projectFilesById: {
          ...s.projectFilesById,
          ...Object.fromEntries(files.map(f => [f.fileId, f])),
        },
      })),

      setPendingSearch: (pendingSearch) => set({ pendingSearch }),

      getMessagesCache: (chatId) => get().messagesCache[chatId],
      setMessagesCache: (chatId, data) => set((s) => {
        const cacheOrder = [...s.cacheOrder.filter(id => id !== chatId), chatId]
        const messagesCache = { ...s.messagesCache, [chatId]: data }
        while (cacheOrder.length > MESSAGES_CACHE_CAP) {
          const evicted = cacheOrder.shift()
          if (evicted) delete messagesCache[evicted]
        }
        return { messagesCache, cacheOrder }
      }),
      invalidateMessagesCache: (chatId) => set((s) => {
        const { [chatId]: _removed, ...messagesCache } = s.messagesCache
        void _removed
        return { messagesCache, cacheOrder: s.cacheOrder.filter(id => id !== chatId) }
      }),
    }),
    {
      name: 'chatrock-store',
      // `models` is persisted so the model pickers render populated on first paint instead of
      // waiting out a cold-start GET /api/models — the list is a static server-side constant,
      // so a stale cached copy is at worst one deploy behind and is refreshed in the
      // background on every load. See docs/adr/0028-composer-owns-per-send-controls.md.
      partialize: (s) => ({
        lastModel: s.lastModel,
        sidebarWidth: s.sidebarWidth,
        sidebarSplit: s.sidebarSplit,
        activePanel: s.activePanel,
        userPreferences: s.userPreferences,
        models: s.models,
      }),
    }
  )
)
