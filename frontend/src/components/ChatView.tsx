import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBars, faPaperPlane, faSpinner, faStop, faXmark, faChevronUp, faChevronDown, faPaperclip, faFile, faToggleOn, faToggleOff, faFolderOpen, faEyeSlash, faTriangleExclamation, faGear } from '@fortawesome/free-solid-svg-icons'
import { api, defaultSettings, migrateSettings, requestUpload, uploadToS3 } from '../api/http'
import type { Model, ModelCapabilities, ModelSettings, TokenUsage, Message, Step } from '../api/http'
import { parseSearchResults, parseSearchHistoryResults } from '../lib/toolResults'
import { newId } from '../lib/ids'
import { useSaveStatus } from '../lib/useSaveStatus'
import { sendMessage, cancelMessage, ensureConnected, disconnect, setWSHandlers } from '../api/ws'
import type { WSEvent } from '../api/ws'
import { useChatStore } from '../store/chatStore'
import MessageBubble, { UsageStats } from './MessageBubble'
import ChatDetailsDialog from './ChatDetailsDialog'
import { describeChatPrivacy } from '../lib/privacyDescription'

interface Props {
  accessToken: string
  models: Model[]
  defaultModel: string
  onModelChange: (modelId: string) => void
  onOpenSidebar: () => void
}

// Mirrors the $mobile breakpoint in app.scss — below it, the on-screen keyboard makes
// Shift+Enter awkward to reach, so Enter always inserts a newline and the send button
// (or its arrow) is the only way to submit.
const isMobileViewport = () => window.matchMedia('(max-width: 720px)').matches

export default function ChatView({ accessToken, models, defaultModel, onModelChange, onOpenSidebar }: Props) {
  const { chatId } = useParams<{ chatId?: string }>()
  const navigate = useNavigate()
  const isNew = !chatId || chatId === 'new'

  const {
    chats, patchChat, clearModelMigrationNotice, messages, streamingMsg,
    setMessages, startStream, appendDelta, appendThinkingDelta, markThinkingDone,
    addToolCall, updateToolCallInput, resolveToolCall, setStreamUsage, setStreamIdle, finalizeStream, finalizeStreamErrored, clearStream,
    renameChat, removeChat, sending, setSending, pushToast,
    userPreferences, triggerMemoryRefresh,
    draftModelSettings, draftSystemPrompt,
    setCurrentChatId, setDraftModelSettings, setDraftSystemPrompt,
    updateChatSettings, updateChatSystemPrompt,
    projects, mergeProjectFiles,
    newChatTick,
  } = useChatStore()

  // For /c/new: local model state (not yet persisted)
  const [newModel, setNewModel] = useState(defaultModel)
  // For /c/new: draft sensitive/ephemeral flags, independently settable — mirrors the
  // saved-chat cog exactly (see handleToggleFlag) so the Chat details dialog is the same
  // component in both states. Included directly in the createChat() flags payload.
  const [draftSensitive, setDraftSensitive] = useState(false)
  const [draftEphemeral, setDraftEphemeral] = useState(false)
  // For /c/new: project picker in the header, so a chat can be filed into a project
  // before its first send instead of only via "New chat" from inside a project.
  const [draftProjectId, setDraftProjectId] = useState('')
  const [detailsOpen, setDetailsOpen] = useState(false)

  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  interface PendingAttachment {
    id: string
    file?: File                 // absent for attachments re-loaded from a past message
    contentType: string
    filename: string
    attachmentKind: 'image' | 'document'
    mode: 'standard' | 'rich'
    s3Key?: string
    localUrl?: string           // blob: preview for freshly added files
    url?: string                // signed CloudFront URL for re-loaded attachments
    status: 'uploading' | 'ready' | 'error'
    errorMsg?: string
  }

  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null)
  const [editParentId, setEditParentId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [creatingChat, setCreatingChat] = useState(false)
  const [loadingMessages, setLoadingMessages] = useState(false)

  // Conversation-level usage (from listMessages on load + updated after each exchange)
  const [conversationUsage, setConversationUsage] = useState<TokenUsage | null>(null)
  // Latest-turn usage (from the most recent 'usage' WS event)
  const [lastTurnUsage, setLastTurnUsage] = useState<TokenUsage | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  // bubble DOM refs for prev/next stepping (C3)
  const bubbleRefsRef = useRef<(HTMLDivElement | null)[]>([])
  const pendingScrollTopRef = useRef(false)
  const justLoadedRef = useRef(false)
  const streamCancelledRef = useRef(false)
  const idleTimerRef = useRef<number | null>(null)
  // Delivery watchdog: armed after each send; cleared by the server's `ack` (or any
  // frame). If it fires, the send was dropped by a stale WebSocket — recover instead
  // of hanging on "Processing…" forever.
  const ackTimerRef = useRef<number | null>(null)
  // msgId of the optimistic user bubble for the in-flight send (removed on ack-timeout).
  const optimisticMsgIdRef = useRef<string | null>(null)
  const pendingSendRef = useRef<{ content: string; attachments: PendingAttachment[]; wasNew: boolean } | null>(null)
  const pendingNewChatIdRef = useRef<string | null>(null)
  // Debounce refs for the Chat details dialog's system-prompt/model-settings edits
  // (moved here from the old PreferencesPanel "This chat" tab — same 800ms pattern).
  const chatInstructionsDebounceRef = useRef<number | null>(null)
  const { status: systemPromptSaveStatus, track: trackSystemPromptSave } = useSaveStatus()
  const chatSettingsDebounceRef = useRef<number | null>(null)
  const [showScrollDown, setShowScrollDown] = useState(false)
  // Ref so the WS done-handler can access the current chatId without stale closure
  const chatIdRef = useRef<string | undefined>(chatId)

  // Sensitive chats are returned by GET /api/chats like any other (visibility is a frontend
  // filter, not an API-level exclusion — see "Sensitive & ephemeral chats" in backend/CLAUDE.md),
  // so activeChat is a plain lookup with no fallback fetch needed.
  const activeChat = isNew ? null : chats.find(c => c.chatId === chatId)
  const chatProject = activeChat?.projectId ? projects.find(p => p.projectId === activeChat.projectId) : null

  const currentModelId = isNew ? (newModel || defaultModel) : (activeChat?.model || defaultModel)
  const currentModelDef = models.find(m => m.id === currentModelId)
  const currentCaps: ModelCapabilities = currentModelDef?.capabilities
    ?? { provider: 'bedrock-converse', temperature: true, topP: true, topK: false, thinking: 'none', attachments: true, documents: true, promptCaching: 'none' }

  // Per-chat override wins when set; otherwise fall back to the global default. Usage is
  // always recorded either way — this only gates whether it's rendered.
  const effectiveShowTokenStats = draftModelSettings.showTokenStats ?? userPreferences.showTokenStats ?? false

  const ALLOWED_TYPES: Record<string, 'image' | 'document'> = {
    'image/png': 'image', 'image/jpeg': 'image', 'image/gif': 'image', 'image/webp': 'image',
    'application/pdf': 'document',
    'text/plain': 'document', 'text/markdown': 'document', 'text/x-markdown': 'document',
    'text/csv': 'document', 'application/octet-stream': 'document',
  }
  const MAX_SIZES: Record<string, number> = {
    'image/png': 5 * 1024 * 1024, 'image/jpeg': 5 * 1024 * 1024,
    'image/gif': 5 * 1024 * 1024, 'image/webp': 5 * 1024 * 1024,
    'application/pdf': 25 * 1024 * 1024,
    'text/plain': 1 * 1024 * 1024, 'text/markdown': 1 * 1024 * 1024,
    'text/x-markdown': 1 * 1024 * 1024, 'text/csv': 1 * 1024 * 1024,
    'application/octet-stream': 1 * 1024 * 1024,
  }
  // Browsers report wildly inconsistent (or empty) contentType for text/code files
  // depending on OS file associations (e.g. .csv as application/vnd.ms-excel on
  // Windows, .json/.yaml/.py often with no contentType at all) -- extension is the
  // reliable signal for these, so they're classified by extension instead.
  const TEXT_EXTENSIONS = new Set([
    'csv', 'tsv', 'md', 'markdown', 'txt', 'log', 'json', 'jsonl', 'ndjson',
    'yaml', 'yml', 'xml', 'html', 'htm', 'css', 'scss', 'less',
    'ini', 'cfg', 'conf', 'toml', 'env', 'properties',
    'sh', 'bash', 'zsh', 'bat', 'ps1', 'sql', 'py', 'rb', 'php', 'go', 'rs',
    'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'java', 'kt', 'kts',
    'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'swift', 'lua', 'pl', 'r',
    'scala', 'dart', 'vue', 'svelte', 'graphql', 'gql', 'proto', 'diff', 'patch',
    'gitignore', 'dockerfile', 'makefile', 'rst', 'tex',
  ])

  function extOf(filename: string): string {
    const m = /\.([a-zA-Z0-9]+)$/.exec(filename)
    return m ? m[1].toLowerCase() : ''
  }

  function newChatUploadId(): string {
    if (!pendingNewChatIdRef.current) pendingNewChatIdRef.current = newId()
    return pendingNewChatIdRef.current
  }

  // Bedrock vision gets no quality benefit above ~1568px on the long edge, and phone photos
  // (iPhones especially) routinely exceed MAX_SIZES at full sensor resolution — re-encode down
  // to a size that's still well above what the model uses, so full-resolution originals don't
  // hit the cap. Returns the original file unchanged if it's already small or decoding fails
  // (e.g. a format the browser can't rasterize onto a canvas).
  const MAX_IMAGE_DIMENSION = 2048
  const IMAGE_JPEG_QUALITY = 0.85

  async function downscaleImage(file: File): Promise<File> {
    try {
      const bitmap = await createImageBitmap(file)
      const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height))
      if (scale >= 1) {
        bitmap.close()
        return file
      }
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(bitmap.width * scale)
      canvas.height = Math.round(bitmap.height * scale)
      const ctx2d = canvas.getContext('2d')
      if (!ctx2d) {
        bitmap.close()
        return file
      }
      ctx2d.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      bitmap.close()
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', IMAGE_JPEG_QUALITY))
      if (!blob || blob.size >= file.size) return file
      return new File([blob], file.name, { type: 'image/jpeg' })
    } catch {
      return file
    }
  }

  function addFiles(files: File[]) {
    const currentChatId = chatId && chatId !== 'new' ? chatId : newChatUploadId()
    for (const file of files) {
      void addOneFile(file, currentChatId)
    }
  }

  async function addOneFile(file: File, currentChatId: string) {
    let ct = file.type || 'application/octet-stream'
    let kind = ALLOWED_TYPES[ct]

    if (!kind) {
      const ext = extOf(file.name)
      if (TEXT_EXTENSIONS.has(ext) || file.type.startsWith('text/')) {
        ct = ext === 'csv' || ext === 'tsv' ? 'text/csv' : ext === 'md' || ext === 'markdown' ? 'text/markdown' : 'text/plain'
        kind = 'document'
      } else if (confirm(`Chatrock doesn't recognize "${file.name}" as a supported file type. Attach it as plain text anyway?`)) {
        ct = 'text/plain'
        kind = 'document'
      } else {
        pushToast({ kind: 'error', text: `File type not supported: ${file.name}` })
        return
      }
    }

    let uploadFile = file
    if (kind === 'image') {
      uploadFile = await downscaleImage(file)
      ct = uploadFile.type || ct
    }

    const maxBytes = MAX_SIZES[ct] ?? 1 * 1024 * 1024
    if (uploadFile.size > maxBytes) {
      pushToast({ kind: 'error', text: `File too large: ${file.name}` })
      return
    }
    const id = crypto.randomUUID()
    const localUrl = kind === 'image' ? URL.createObjectURL(uploadFile) : undefined
    const att: PendingAttachment = {
      id, file: uploadFile, contentType: ct, filename: uploadFile.name,
      attachmentKind: kind, mode: 'standard', localUrl, status: 'uploading',
    }
    setAttachments(prev => [...prev, att])

    requestUpload({ chatId: currentChatId, filename: uploadFile.name, contentType: ct, sizeBytes: uploadFile.size })
      .then(({ s3Key, uploadUrl }) => uploadToS3(uploadUrl, uploadFile).then(() => s3Key))
      .then(s3Key => {
        setAttachments(prev => prev.map(a => a.id === id ? { ...a, s3Key, status: 'ready' } : a))
      })
      .catch(e => {
        const msg = e instanceof Error ? e.message : String(e)
        setAttachments(prev => prev.map(a => a.id === id ? { ...a, status: 'error', errorMsg: msg } : a))
      })
  }

  // Keep ref in sync after each render (must be an effect, not during render)
  useEffect(() => { chatIdRef.current = chatId })

  // Revoke object URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      attachments.forEach(a => { if (a.localUrl) URL.revokeObjectURL(a.localUrl) })
      if (chatInstructionsDebounceRef.current !== null) clearTimeout(chatInstructionsDebounceRef.current)
      if (chatSettingsDebounceRef.current !== null) clearTimeout(chatSettingsDebounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reload messages for a given chatId, applying tool-result enrichment.
  // Used both by the load effect and the post-stream done-handler refetch.
  const reloadMessages = useCallback((id: string) => {
    api.listMessages(id).then(r => {
      if (useChatStore.getState().sending) return
      const enriched = r.bubbles.map(msg => {
        if (!msg.steps?.some(s => s.kind === 'tool')) return msg
        return {
          ...msg,
          steps: msg.steps.map(step => {
            if (step.kind !== 'tool') return step
            return {
              ...step,
              searchResults: parseSearchResults(step.name, step.result, step.isError),
              searchHistoryResults: parseSearchHistoryResults(step.name, step.result, step.isError),
            }
          }),
        }
      })
      setMessages(enriched)
      setConversationUsage(r.conversationUsage)
    }).catch(() => {})
  }, [setMessages])

  // Sync newModel when defaultModel resolves (models loaded async)
  useEffect(() => {
    if (isNew && defaultModel && !newModel) setNewModel(defaultModel)
  }, [defaultModel, isNew, newModel])

  // A Search submitted from the global header (App.tsx) lands here as a single-use pendingSearch —
  // fire the same new-chat-send flow handleSend() uses for a normal first message, but with the
  // typed query as content and search:{scope} threaded through so the backend forces the
  // search_history tool. Cleared synchronously (before the async send) so a StrictMode
  // double-invoke of this effect can't fire it twice.
  useEffect(() => {
    if (!isNew) return
    const pf = useChatStore.getState().pendingSearch
    if (!pf) return
    useChatStore.getState().setPendingSearch(null)
    void handleSend(pf.query, { scope: pf.scope }, pf.projectId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew])

  // Project files are normally loaded by ProjectView/ProjectsPanel into the shared
  // projectFilesById map. Opening a project chat directly (deep link, reload) never
  // visits those screens, so read_project_file tool pills fell back to showing the
  // raw fileId instead of the filename. Load them here too whenever a chat belongs
  // to a project.
  const chatProjectId = chatProject?.projectId
  useEffect(() => {
    if (!chatProjectId) return
    api.listProjectFiles(chatProjectId).then(r => mergeProjectFiles(r.files)).catch(() => {})
  }, [chatProjectId, mergeProjectFiles])

  // Pre-fill input with a draft when navigating to the fork (set via pendingDraftRef before navigate)
  const pendingDraftRef = useRef<string | null>(null)
  useEffect(() => {
    if (pendingDraftRef.current) {
      setInput(pendingDraftRef.current)
      pendingDraftRef.current = null
    }
  }, [chatId])

  // Seed draftModelSettings when chatId changes
  useEffect(() => {
    setCurrentChatId(chatId ?? null)
    if (isNew) {
      setDraftSystemPrompt('')
      if (currentModelDef) {
        const base = defaultSettings(currentModelDef.capabilities)
        setDraftModelSettings({
          ...base,
          ...(userPreferences.webSearchEnabled !== undefined ? { webSearchEnabled: userPreferences.webSearchEnabled } : {}),
          ...(currentModelDef.capabilities.thinking !== 'none' && userPreferences.thinkingEffort !== undefined
            ? { thinkingEffort: userPreferences.thinkingEffort }
            : {}),
          ...(currentModelDef.capabilities.temperature && userPreferences.temperature !== undefined
            ? { temperature: userPreferences.temperature }
            : {}),
          ...(currentModelDef.capabilities.topP && userPreferences.topP !== undefined
            ? { topP: userPreferences.topP }
            : {}),
        })
      }
    } else {
      const chat = useChatStore.getState().chats.find(c => c.chatId === chatId)
      if (chat?.modelSettings && Object.keys(chat.modelSettings).length > 0) {
        setDraftModelSettings(chat.modelSettings)
      } else if (currentModelDef) {
        const base = defaultSettings(currentModelDef.capabilities)
        const project = chat?.projectId
          ? useChatStore.getState().projects.find(p => p.projectId === chat.projectId)
          : null
        const projectLayer = project?.modelSettings ?? {}
        setDraftModelSettings({
          ...base,
          ...(userPreferences.webSearchEnabled !== undefined ? { webSearchEnabled: userPreferences.webSearchEnabled } : {}),
          ...(currentModelDef.capabilities.thinking !== 'none' && userPreferences.thinkingEffort !== undefined
            ? { thinkingEffort: userPreferences.thinkingEffort }
            : {}),
          ...projectLayer,
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, isNew])

  // Backfill: if chats were not loaded when the seed effect ran (cold navigation),
  // fill draftModelSettings once the chat record arrives in the store.
  useEffect(() => {
    if (isNew || !chatId) return
    if (Object.keys(draftModelSettings).length > 0) return  // already seeded
    const chat = chats.find(c => c.chatId === chatId)
    if (chat?.modelSettings && Object.keys(chat.modelSettings).length > 0) {
      setDraftModelSettings(chat.modelSettings)
    } else if (chat) {
      const project = chat.projectId ? projects.find(p => p.projectId === chat.projectId) : null
      const projectLayer = project?.modelSettings ?? {}
      if (Object.keys(projectLayer).length > 0) {
        setDraftModelSettings({ ...projectLayer })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, chatId, isNew])

  // Register WS event handler
  useEffect(() => {
    setWSHandlers((evt: WSEvent) => {
      // Any frame proves the WebSocket is live → disarm the delivery watchdog.
      clearAckTimer()
      if (evt.type === 'ack') return  // delivery confirmation only; nothing to render
      // Allow titleUpdated (title gen runs independently of stream cancel) and
      // error (always show server errors) and cancelled (needed for timely reload
      // after the server persists the partial cancelled turn) to pass through.
      if (streamCancelledRef.current &&
          evt.type !== 'titleUpdated' &&
          evt.type !== 'error' &&
          evt.type !== 'warning' &&
          evt.type !== 'cancelled') return
      if (evt.type === 'delta') {
        bumpIdleTimer()
        appendDelta(evt.text)
      } else if (evt.type === 'thinking_delta') {
        bumpIdleTimer()
        appendThinkingDelta(evt.text)
      } else if (evt.type === 'thinking_done') {
        markThinkingDone()
      } else if (evt.type === 'tool_call_start') {
        bumpIdleTimer()
        addToolCall({ toolUseId: evt.toolUseId, name: evt.name, input: '' })
      } else if (evt.type === 'tool_call') {
        bumpIdleTimer()
        updateToolCallInput(evt.toolUseId, evt.input)
      } else if (evt.type === 'tool_result') {
        bumpIdleTimer()
        resolveToolCall(evt.toolUseId, evt.content ?? '', evt.isError, evt.screenshotUrls)
      } else if (evt.type === 'usage') {
        setStreamUsage(evt.usage)
        setLastTurnUsage(evt.usage)
        // Update conversation total
        setConversationUsage(prev => prev ? {
          inputTokens: prev.inputTokens + evt.usage.inputTokens,
          outputTokens: prev.outputTokens + evt.usage.outputTokens,
          cacheReadInputTokens: (prev.cacheReadInputTokens ?? 0) + (evt.usage.cacheReadInputTokens ?? 0),
          cacheWriteInputTokens: (prev.cacheWriteInputTokens ?? 0) + (evt.usage.cacheWriteInputTokens ?? 0),
        } : { ...evt.usage })
      } else if (evt.type === 'done' || evt.type === 'cancelled') {
        clearIdleTimer()
        finalizeStream()
        setSending(false)
        // Hydrate real msgId/parentId on the just-streamed answer so every
        // bubble is immediately re-runnable without a page reload.
        const currentId = chatIdRef.current
        if (currentId && currentId !== 'new') {
          reloadMessages(currentId)
        }
      } else if (evt.type === 'titleUpdated') {
        renameChat(evt.chatId, evt.title)
      } else if (evt.type === 'memoryUpdated') {
        triggerMemoryRefresh()
        pushToast({
          kind: 'info',
          text: evt.count > 1 ? `Memory updated (${evt.count} new facts)` : 'Memory updated',
          items: evt.items,
        })
      } else if (evt.type === 'warning') {
        pushToast({ kind: 'error', text: evt.message })
      } else if (evt.type === 'error') {
        clearIdleTimer()
        // Preserve the partial streaming bubble (not clearStream) so the user
        // sees what was generated before the error and can Continue from it.
        finalizeStreamErrored()
        setSending(false)
        setErrorMsg(evt.message)
        // Reload to hydrate the real msgId/parentId/errored flag from DDB
        // (backend now persists the partial turn and advances activeLeafId on error)
        const currentId = chatIdRef.current
        if (currentId && currentId !== 'new') {
          reloadMessages(currentId)
        }
      }
    })
  }, [appendDelta, appendThinkingDelta, markThinkingDone, addToolCall, updateToolCallInput, resolveToolCall, setStreamUsage, setStreamIdle, finalizeStream, finalizeStreamErrored, clearStream, renameChat, setSending, reloadMessages, triggerMemoryRefresh])

  // Load messages when chatId changes.
  // Guard against two races:
  //   1. Effect re-runs (chatId changed): cancelled flag drops stale result
  //   2. User sends while fetch is in flight: check sending via getState() at
  //      resolve time (not the captured closure value) so we don't overwrite
  //      the optimistic user+assistant messages with stale DB records.
  useEffect(() => {
    if (isNew || !chatId) {
      setMessages([])
      setConversationUsage(null)
      setLoadingMessages(false)
      return
    }
    // Don't clobber the optimistic messages while a stream is in flight
    // (e.g. new-chat navigate fires this effect with sending=true)
    if (useChatStore.getState().sending) return
    // Clear messages immediately so stale content doesn't linger while loading
    setMessages([])
    setConversationUsage(null)
    setLoadingMessages(true)
    let cancelled = false
    api.listMessages(chatId).then(r => {
      if (cancelled || useChatStore.getState().sending) return
      const enriched = r.bubbles.map(msg => {
        if (!msg.steps?.some(s => s.kind === 'tool')) return msg
        return {
          ...msg,
          steps: msg.steps.map(step => {
            if (step.kind !== 'tool') return step
            return {
              ...step,
              searchResults: parseSearchResults(step.name, step.result, step.isError),
              searchHistoryResults: parseSearchHistoryResults(step.name, step.result, step.isError),
            }
          }),
        }
      })
      setMessages(enriched)
      setConversationUsage(r.conversationUsage)
      justLoadedRef.current = true
    }).catch(() => {
      if (!cancelled) navigate('/c/new', { replace: true })
    }).finally(() => {
      if (!cancelled) setLoadingMessages(false)
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, isNew])

  // After a send, pin the user's question to the top of the viewport so the answer
  // streams in below it.  Use instant scrollTop arithmetic — smooth scroll gets
  // interrupted by streaming delta re-renders and never finishes.
  useEffect(() => {
    if (!pendingScrollTopRef.current) return
    pendingScrollTopRef.current = false
    const container = messagesRef.current
    const refs = bubbleRefsRef.current.filter((el): el is HTMLDivElement => !!el)
    // The streaming assistant bubble (if present) is last; the user question is the one before it.
    const target = streamingMsg ? refs[refs.length - 2] : refs[refs.length - 1]
    if (!container || !target) return
    // offsetTop of the target relative to the scrollable container
    container.scrollTop = target.offsetTop - container.offsetTop
  }, [messages, streamingMsg])

  // Instant jump to bottom when opening a chat (no smooth scroll)
  useEffect(() => {
    if (!justLoadedRef.current) return
    justLoadedRef.current = false
    const el = messagesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // Reset bubble refs when chat changes
  useEffect(() => {
    setShowScrollDown(false)
    bubbleRefsRef.current = []
    pendingNewChatIdRef.current = null
    clearIdleTimer()
    clearAckTimer()
  }, [chatId])

  // Focus the input whenever a new-chat is requested (covers both navigation
  // from an existing chat and clicking "+" while already on /c/new)
  useEffect(() => {
    if (newChatTick > 0) requestAnimationFrame(() => inputRef.current?.focus())
  }, [newChatTick])

  // Sensitive/ephemeral/project must default off for every fresh /c/new — they should
  // never silently carry over from a previous chat the user made sensitive or filed.
  useEffect(() => { setDraftSensitive(false); setDraftEphemeral(false); setDraftProjectId('') }, [newChatTick])

  // Close the Chat details dialog when switching chats so it doesn't linger open across
  // navigation to a different chat.
  useEffect(() => { setDetailsOpen(false) }, [chatId])

  function handleMessagesScroll() {
    const el = messagesRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    setShowScrollDown(!atBottom)
  }

  function scrollToBottom() {
    setShowScrollDown(false)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  function scrollToTop() {
    const el = messagesRef.current
    if (!el) return
    el.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Derive the current bubble from actual scroll position rather than tracking a separate
  // index — scrollToTop/scrollToBottom/manual scrolling would otherwise leave a stale index
  // behind, so "prev/next" steps from where the user is actually looking.
  function currentBubbleIndex(refs: HTMLDivElement[]): number {
    const container = messagesRef.current
    if (!container || refs.length === 0) return -1
    const containerTop = container.getBoundingClientRect().top
    let best = 0
    let bestDist = Infinity
    refs.forEach((el, i) => {
      const dist = Math.abs(el.getBoundingClientRect().top - containerTop)
      if (dist < bestDist) { bestDist = dist; best = i }
    })
    return best
  }

  function stepBubble(dir: 1 | -1) {
    const refs = bubbleRefsRef.current.filter((el): el is HTMLDivElement => !!el)
    if (refs.length === 0) return
    const current = currentBubbleIndex(refs)
    const next = Math.max(0, Math.min(refs.length - 1, current + dir))
    refs[next]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const handleNavigate = useCallback(async (targetMsgId: string) => {
    if (!chatId || isNew || sending) return
    try {
      await api.setActiveLeaf(chatId, targetMsgId)
      reloadMessages(chatId)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }, [chatId, isNew, sending, reloadMessages])

  const handleDeleteBranch = useCallback(async (msgId: string) => {
    if (!chatId || isNew || sending) return
    try {
      await api.deleteBranch(chatId, msgId)
      reloadMessages(chatId)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }, [chatId, isNew, sending, reloadMessages])

  const handleForkToHere = useCallback(async (fromMsgId: string, role: 'user' | 'assistant', text: string) => {
    if (!chatId || isNew || !activeChat) return
    try {
      const res = await api.forkChat(chatId, fromMsgId)
      // Backend inherits sensitive/ephemeral from the source, with a FRESH ttl (not the
      // source's remaining one) — fetch the authoritative DTO rather than hand-building one,
      // so expiresAt is correct from the start.
      const forked = await api.getChat(res.chatId)
      useChatStore.getState().addChat(forked)
      pushToast({ kind: 'success', text: activeChat.sensitive ? 'Forked into a new sensitive chat' : 'Forked into a new chat' })
      if (role === 'user') pendingDraftRef.current = text
      navigate(`/c/${res.chatId}`)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }, [chatId, isNew, activeChat, navigate])

  const handleEditRequest = useCallback((message: Message) => {
    // Revoke any in-flight blob previews from a prior draft
    setAttachments(prev => { prev.forEach(a => { if (a.localUrl) URL.revokeObjectURL(a.localUrl) }); return [] })
    const text = message.steps?.find(s => s.kind === 'text')?.text ?? ''
    setInput(text)
    const atts: PendingAttachment[] = (message.steps ?? [])
      .filter((s): s is Extract<Step, { kind: 'attachment' }> => s.kind === 'attachment')
      .map(s => ({
        id: crypto.randomUUID(),
        contentType: s.contentType,
        filename: s.filename,
        attachmentKind: s.attachmentKind,
        mode: s.mode ?? 'standard',
        s3Key: s.s3Key,
        url: s.url,
        status: 'ready' as const,
      }))
    setAttachments(atts)
    setEditingMsgId(message.msgId)
    setEditParentId(message.parentId ?? null)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [])

  const cancelEdit = useCallback(() => {
    setAttachments(prev => { prev.forEach(a => { if (a.localUrl) URL.revokeObjectURL(a.localUrl) }); return [] })
    setInput('')
    setEditingMsgId(null)
    setEditParentId(null)
  }, [])

  const handleRerun = useCallback(async (parentId: string) => {
    if (!activeChat || useChatStore.getState().sending || creatingChat) return
    streamCancelledRef.current = false
    setSending(true)
    setErrorMsg(null)
    setLastTurnUsage(null)

    // Optimistic truncate: keep everything up to and including the user turn (parentId),
    // drop the old answer and any later messages from view.
    const cut = messages.findIndex(m => m.msgId === parentId)
    if (cut >= 0) setMessages(messages.slice(0, cut + 1))
    startStream()
    pendingScrollTopRef.current = true

    optimisticMsgIdRef.current = null  // re-run has no optimistic user bubble
    try {
      await ensureConnected(accessToken)
      sendMessage({
        chatId: chatId!,
        model: activeChat.model,
        systemPrompt: activeChat.systemPrompt,
        modelSettings: draftModelSettings,
        parentId,
      })
      armAckWatchdog()
    } catch (err) {
      setSending(false)
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }, [activeChat, creatingChat, messages, chatId, accessToken, draftModelSettings, startStream])

  const handleContinue = useCallback(async (msgId: string) => {
    if (!activeChat || useChatStore.getState().sending || creatingChat) return
    streamCancelledRef.current = false
    setSending(true)
    setErrorMsg(null)
    setLastTurnUsage(null)
    startStream()
    pendingScrollTopRef.current = true

    optimisticMsgIdRef.current = null  // continue has no optimistic user bubble
    try {
      await ensureConnected(accessToken)
      sendMessage({
        chatId: chatId!,
        model: activeChat.model,
        systemPrompt: activeChat.systemPrompt,
        modelSettings: draftModelSettings,
        parentId: msgId,
        continue: true,
      })
      armAckWatchdog()
    } catch (err) {
      setSending(false)
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }, [activeChat, creatingChat, chatId, accessToken, draftModelSettings, startStream])

  const stepHasContent = (st: Step) =>
    (st.kind === 'text' && st.text.trim() !== '') ||
    (st.kind === 'thinking' && st.text.trim() !== '') ||
    st.kind === 'tool'

  function clearIdleTimer() {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
  }
  function bumpIdleTimer() {
    clearIdleTimer()
    setStreamIdle(false)
    idleTimerRef.current = window.setTimeout(() => setStreamIdle(true), 2000)
  }

  function clearAckTimer() {
    if (ackTimerRef.current !== null) {
      clearTimeout(ackTimerRef.current)
      ackTimerRef.current = null
    }
  }

  // Arm after a send. The server emits `ack` the instant it receives the frame, so
  // ~12s of total silence means the frame never landed (stale socket). Cold starts
  // and slow first tokens are well within this window; the timer is cleared by the
  // first frame of any kind.
  function armAckWatchdog() {
    clearAckTimer()
    ackTimerRef.current = window.setTimeout(handleAckTimeout, 12000)
  }

  function handleAckTimeout() {
    ackTimerRef.current = null
    clearIdleTimer()
    clearStream()
    setSending(false)
    setLastTurnUsage(null)
    // The optimistic user bubble was never persisted server-side — drop it so the
    // UI doesn't show a message that isn't really there.
    const optId = optimisticMsgIdRef.current
    if (optId) {
      const remaining = useChatStore.getState().messages.filter(m => !('msgId' in m) || m.msgId !== optId)
      setMessages(remaining)
    }
    optimisticMsgIdRef.current = null
    // Restore the typed content + attachments so a resend is one keypress away.
    const draft = pendingSendRef.current
    if (draft && draft.content) {
      setInput(draft.content)
      setAttachments(draft.attachments)
    }
    pushToast({ kind: 'error', text: 'Message not delivered — the connection dropped. Reconnecting; please send again.' })
    // Drop the stale socket and reopen so the resend uses a fresh connection.
    disconnect()
    ensureConnected(accessToken).catch(() => {})
  }

  function handleStop() {
    streamCancelledRef.current = true
    clearIdleTimer()
    clearAckTimer()
    const sm = useChatStore.getState().streamingMsg
    const producedContent = !!sm && sm.steps.some(stepHasContent)
    const currentId = chatIdRef.current
    const draft = pendingSendRef.current

    // New chat, Stop before any answer: restore the question so it can be resubmitted.
    if (!producedContent && draft?.wasNew && currentId && currentId !== 'new') {
      cancelMessage()
      clearStream()
      setSending(false)
      setInput(draft.content)
      setAttachments(draft.attachments)
      pendingSendRef.current = null
      api.deleteChat(currentId).catch(() => {})
      removeChat(currentId)
      navigate('/c/new', { replace: true })
      return
    }

    // Default: keep whatever partial content streamed.
    finalizeStream()
    setSending(false)
    if (currentId && currentId !== 'new') reloadMessages(currentId)
    cancelMessage()
  }

  // overrideContent/search/projectIdOverride are set only by the pendingSearch mount effect
  // below — a normal send from the composer passes none of them and reads from `input` as before.
  async function handleSend(overrideContent?: string, search?: { scope: 'project' | 'global' }, projectIdOverride?: string) {
    const effectiveProjectId = projectIdOverride ?? (draftProjectId || undefined)
    const content = (overrideContent ?? input).trim()
    const readyAttachments = attachments.filter(a => a.status === 'ready')
    if ((!content && readyAttachments.length === 0) || sending || creatingChat) return
    if (attachments.some(a => a.status === 'uploading')) {
      pushToast({ kind: 'error', text: 'Please wait for uploads to finish' })
      return
    }
    const editMsgId = editingMsgId
    const editPid = editParentId
    setInput('')
    setAttachments([])
    setEditingMsgId(null)
    setEditParentId(null)
    if (inputRef.current) inputRef.current.style.height = 'auto'
    setErrorMsg(null)
    setLastTurnUsage(null)
    streamCancelledRef.current = false

    const attachmentsPayload = readyAttachments.map(a => ({
      s3Key: a.s3Key!,
      contentType: a.contentType,
      filename: a.filename,
      mode: a.mode,
    }))

    // Optimistic user bubble (format C: steps-based)
    const optimisticUser = {
      msgId: crypto.randomUUID(),
      role: 'user' as const,
      steps: [
        ...(content ? [{ kind: 'text' as const, text: content }] : []),
        ...readyAttachments.map(a => ({
          kind: 'attachment' as const,
          attachmentKind: a.attachmentKind,
          filename: a.filename,
          contentType: a.contentType,
          url: a.localUrl ?? a.url ?? '',
          s3Key: a.s3Key!,
          mode: a.mode,
        })),
      ],
      model: '',
      createdAt: new Date().toISOString(),
    }

    pendingSendRef.current = { content, attachments: readyAttachments, wasNew: isNew }
    optimisticMsgIdRef.current = optimisticUser.msgId

    if (isNew) {
      setCreatingChat(true)
      const model = newModel || defaultModel
      const systemPrompt = draftSystemPrompt

      setSending(true)
      setMessages([optimisticUser])
      startStream()
      pendingScrollTopRef.current = true

      try {
        const newChatId = pendingNewChatIdRef.current ?? newId()
        const res = await api.createChat(model, systemPrompt, newChatId, draftModelSettings, effectiveProjectId, { sensitive: draftSensitive, ephemeral: draftEphemeral })
        pendingNewChatIdRef.current = null
        const now = new Date().toISOString()
        if (draftSensitive || draftEphemeral) {
          // Fetch the authoritative DTO (with expiresAt) rather than hand-building one, so the
          // footer's expiry date is accurate from the start.
          api.getChat(res.chatId).then(c => useChatStore.getState().addChat(c)).catch(() => {})
        } else {
          useChatStore.getState().addChat({
            chatId: res.chatId,
            title: 'New Chat',
            model,
            systemPrompt,
            ...(Object.keys(draftModelSettings).length > 0 ? { modelSettings: draftModelSettings } : {}),
            ...(effectiveProjectId ? { projectId: effectiveProjectId } : {}),
            createdAt: now,
            updatedAt: now,
          })
        }
        await ensureConnected(accessToken)
        sendMessage({
          chatId: res.chatId, content, model, systemPrompt, modelSettings: draftModelSettings, attachments: attachmentsPayload,
          ...(search ? { search } : {}),
        })
        armAckWatchdog()
        navigate(`/c/${res.chatId}`, { replace: true })
      } catch (err) {
        setSending(false)
        setCreatingChat(false)
        setMessages([])
        setErrorMsg(err instanceof Error ? err.message : String(err))
      } finally {
        setCreatingChat(false)
      }
      return
    }

    // Existing chat
    if (!activeChat) return
    setSending(true)

    if (editMsgId) {
      // Edit branch: truncate display to before the edited message, then stream a sibling
      const idx = messages.findIndex(m => 'msgId' in m && m.msgId === editMsgId)
      const base = idx >= 0 ? messages.slice(0, idx) : messages
      setMessages([...base, optimisticUser])
      startStream()
      pendingScrollTopRef.current = true
      try {
        await ensureConnected(accessToken)
        sendMessage({
          chatId: chatId!,
          content,
          model: activeChat.model,
          systemPrompt: activeChat.systemPrompt,
          modelSettings: draftModelSettings,
          parentId: editPid,
          attachments: attachmentsPayload,
        })
        armAckWatchdog()
      } catch (err) {
        setSending(false)
        setErrorMsg(err instanceof Error ? err.message : String(err))
      }
      return
    }

    // Normal send path
    setMessages([
      ...messages,
      optimisticUser,
    ])
    startStream()
    pendingScrollTopRef.current = true

    try {
      await ensureConnected(accessToken)
      sendMessage({
        chatId: chatId!,
        content,
        model: activeChat.model,
        systemPrompt: activeChat.systemPrompt,
        modelSettings: draftModelSettings,
        attachments: attachmentsPayload,
      })
      armAckWatchdog()
    } catch (err) {
      setSending(false)
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }

  function handleModelChange(modelId: string) {
    onModelChange(modelId)
    const newCaps = models.find(m => m.id === modelId)?.capabilities
    if (newCaps) setDraftModelSettings(migrateSettings(draftModelSettings, newCaps))

    if (isNew) {
      setNewModel(modelId)
      return
    }
    if (!chatId) return
    api.updateModel(chatId, modelId)
    useChatStore.setState(s => ({
      chats: s.chats.map(c => c.chatId === chatId ? { ...c, model: modelId } : c),
    }))
  }

  // Chat details dialog: custom instructions + model settings. Applies immediately to
  // local/draft state either way, and debounce-persists to the server for a saved chat
  // (moved here from the old PreferencesPanel "This chat" tab).
  function handleChatInstructionsChange(value: string) {
    if (isNew) {
      setDraftSystemPrompt(value)
    } else if (chatId) {
      updateChatSystemPrompt(chatId, value)
      if (chatInstructionsDebounceRef.current !== null) clearTimeout(chatInstructionsDebounceRef.current)
      chatInstructionsDebounceRef.current = window.setTimeout(() => {
        trackSystemPromptSave(api.updateSystemPrompt(chatId, value))
      }, 800)
    }
  }

  function handleChatSettingsChange(newSettings: ModelSettings) {
    setDraftModelSettings(newSettings)
    if (!isNew && chatId) {
      updateChatSettings(chatId, newSettings)
      if (chatSettingsDebounceRef.current !== null) clearTimeout(chatSettingsDebounceRef.current)
      chatSettingsDebounceRef.current = window.setTimeout(() => {
        api.updateChatSettings(chatId, newSettings).catch(() => {})
      }, 800)
    }
  }

  // Sensitive/ephemeral are independent per-chat flags (see backend/CLAUDE.md) — toggled from
  // the header cog. Applies the flip optimistically so the checkbox/header respond instantly
  // (the PATCH+GET round trip alone felt like nothing was happening), then reconciles with the
  // authoritative DTO — needed for expiresAt, which only the server knows (fresh ttl on
  // enable). Reverts to the pre-toggle values on failure. chatDto() omits
  // sensitive/ephemeral/expiresAt entirely when false/unset, so they're set explicitly here
  // (as `undefined`) rather than spread — a merge-spread would leave a stale `true` in place.
  async function handleToggleFlag(flag: 'sensitive' | 'ephemeral') {
    if (!chatId || isNew || !activeChat) return
    const prev = { sensitive: activeChat.sensitive, ephemeral: activeChat.ephemeral, expiresAt: activeChat.expiresAt }
    const next = !activeChat[flag]
    patchChat(chatId, { ...prev, [flag]: next || undefined, ...(flag === 'ephemeral' && !next ? { expiresAt: undefined } : {}) })
    try {
      await api.updateChatFlags(chatId, { [flag]: next })
      const fresh = await api.getChat(chatId)
      patchChat(chatId, { sensitive: fresh.sensitive, ephemeral: fresh.ephemeral, expiresAt: fresh.expiresAt })
    } catch (err) {
      patchChat(chatId, prev)
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  // One-click "Private" shortcut in the header — sets both flags together in a single
  // PATCH rather than two handleToggleFlag calls. The Chat details dialog still exposes
  // Sensitive/Auto-delete independently for anyone who wants just one.
  async function handleSetPrivate(next: boolean) {
    if (isNew) {
      setDraftSensitive(next)
      setDraftEphemeral(next)
      return
    }
    if (!chatId || !activeChat) return
    const prev = { sensitive: activeChat.sensitive, ephemeral: activeChat.ephemeral, expiresAt: activeChat.expiresAt }
    patchChat(chatId, { sensitive: next || undefined, ephemeral: next || undefined, expiresAt: next ? prev.expiresAt : undefined })
    try {
      await api.updateChatFlags(chatId, { sensitive: next, ephemeral: next })
      const fresh = await api.getChat(chatId)
      patchChat(chatId, { sensitive: fresh.sensitive, ephemeral: fresh.ephemeral, expiresAt: fresh.expiresAt })
    } catch (err) {
      patchChat(chatId, prev)
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleRenameChat(title: string) {
    if (!chatId || isNew) return
    renameChat(chatId, title)
    try {
      await api.renameChat(chatId, title)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  const allMessages = [...messages, ...(streamingMsg ? [streamingMsg] : [])]

  const sensitive = isNew ? draftSensitive : !!activeChat?.sensitive
  const ephemeral = isNew ? draftEphemeral : !!activeChat?.ephemeral
  const isPrivate = sensitive && ephemeral
  const isChatInProject = isNew ? !!draftProjectId : !!chatProject

  return (
    <div className={`chat-view${sensitive ? ' chat-view--private' : ''}`}>
      <div className="chat-header">
        <button className="btn-icon btn-hamburger" onClick={onOpenSidebar} title="Open sidebar">
          <FontAwesomeIcon icon={faBars} />
        </button>
        {/* Sensitive chats never show their title in the header — only in the LHS, gated by
            the "show sensitive" filter. A bold header would announce the topic to anyone
            glancing at the screen even while the sidebar is closed. A plain spacer (not a
            hidden h2) fills the same flex:1 slot so header-controls doesn't shift left —
            the real title text never enters the DOM at all, not even visibility:hidden. */}
        {sensitive
          ? <div className="chat-header-spacer" />
          : <h2>{isNew ? 'New Chat' : (activeChat?.title ?? 'Chat')}</h2>}
        {chatProject && (
          <span
            className="project-chip"
            onClick={() => navigate(`/p/${chatProject.projectId}`)}
            title="View project"
          >
            <FontAwesomeIcon icon={faFolderOpen} /> {chatProject.name}
          </span>
        )}
        {/* Only shown for sensitive-without-ephemeral — once ephemeral is also on, the
            active "Private" toggle button below already says the same thing, so a
            second chip here would just repeat it. */}
        {sensitive && !ephemeral && (
          <span
            className="private-chip"
            title={describeChatPrivacy({
              memoryEnabled: draftModelSettings.memoryEnabled !== false,
              sensitive, isProject: isChatInProject, ephemeral, expiresAt: activeChat?.expiresAt,
            })}
          >
            <FontAwesomeIcon icon={faEyeSlash} /> Sensitive
          </span>
        )}
        <div className="header-controls">
          <button
            type="button"
            className={`btn-private-toggle${isPrivate ? ' active' : ''}`}
            onClick={() => handleSetPrivate(!isPrivate)}
            title={isPrivate
              ? 'Private: sensitive + auto-delete, both on. Click to turn both off.'
              : 'Quick-set Private: sensitive + auto-delete, both on. Use the chat details dialog to set them independently.'}
          >
            <FontAwesomeIcon icon={faEyeSlash} /> <span className="btn-private-label">Private</span>
          </button>
          {isNew && projects.length > 0 && (
            <select
              className="model-select project-picker"
              value={draftProjectId}
              onChange={e => setDraftProjectId(e.target.value)}
              title="File this chat into a project"
            >
              <option value="">No project</option>
              {projects.map(p => (
                <option key={p.projectId} value={p.projectId}>{p.name}</option>
              ))}
            </select>
          )}
          <select
            className="model-select"
            value={currentModelId}
            onChange={e => handleModelChange(e.target.value)}
          >
            {models.map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <button className="btn-icon" onClick={() => setDetailsOpen(true)} title="Chat details">
            <FontAwesomeIcon icon={faGear} />
          </button>
        </div>
      </div>

      {!isNew && activeChat?.modelMigratedFrom && (
        <div className="error-banner warning">
          <span>
            <FontAwesomeIcon icon={faTriangleExclamation} /> This chat's model ({activeChat.modelMigratedFrom}) is no
            longer available — it's been switched to {models.find(m => m.id === activeChat.model)?.name ?? activeChat.model}.
            Please double check the model selection above.
          </span>
          <button onClick={() => clearModelMigrationNotice(activeChat.chatId)} title="Dismiss">
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      )}

      <div className="messages-wrap">
        <div className="messages" ref={messagesRef} onScroll={handleMessagesScroll}>
          {loadingMessages && (
            <div className="messages-loading">
              <FontAwesomeIcon icon={faSpinner} spin />
              <span>Loading…</span>
            </div>
          )}
          {allMessages.length === 0 && isNew && (
            <div className="chat-empty">
              <p>Type a message below to start the conversation.</p>
            </div>
          )}
          {allMessages.map((m, i) => (
            <MessageBubble
              key={'msgId' in m ? m.msgId : `stream-${i}`}
              ref={el => { bubbleRefsRef.current[i] = el }}
              message={m}
              onRerun={!isNew ? handleRerun : undefined}
              onContinue={!isNew ? handleContinue : undefined}
              onNavigate={!isNew ? handleNavigate : undefined}
              onEditRequest={!isNew ? handleEditRequest : undefined}
              onForkToHere={!isNew ? handleForkToHere : undefined}
              onDeleteBranch={!isNew ? handleDeleteBranch : undefined}
              showTokenStats={effectiveShowTokenStats}
            />
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Scroll FABs (C2) + prev/next message nav (C3) */}
        <div className="scroll-fabs">
          <button className="scroll-fab" title="Scroll to top" onClick={scrollToTop}>
            <FontAwesomeIcon icon={faChevronUp} />
          </button>
          <button
            className={`scroll-fab scroll-fab--down${showScrollDown ? ' visible' : ''}`}
            title="Scroll to latest"
            onClick={scrollToBottom}
          >
            <FontAwesomeIcon icon={faChevronDown} />
          </button>
          <button className="scroll-fab" title="Previous message" onClick={() => stepBubble(-1)}>
            ‹
          </button>
          <button className="scroll-fab" title="Next message" onClick={() => stepBubble(1)}>
            ›
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="error-banner">
          <span><FontAwesomeIcon icon={faXmark} /> {errorMsg}</span>
          <button onClick={() => setErrorMsg(null)}>
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      )}

      <div
        className="input-area"
        onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
        onDrop={e => {
          e.preventDefault()
          addFiles(Array.from(e.dataTransfer.files))
        }}
      >
        {(sensitive || ephemeral) && (
          <div className="private-footer">
            <FontAwesomeIcon icon={faEyeSlash} />
            {describeChatPrivacy({
              memoryEnabled: draftModelSettings.memoryEnabled !== false,
              sensitive, isProject: isChatInProject, ephemeral, expiresAt: activeChat?.expiresAt,
            })}
          </div>
        )}

        {/* Token stats line — usage is always recorded regardless of this toggle;
            it only controls whether it's displayed. */}
        {effectiveShowTokenStats && (lastTurnUsage || conversationUsage) && (
          <div className="stats-bar">
            {lastTurnUsage && (
              <UsageStats usage={lastTurnUsage} label="Last:" />
            )}
            {conversationUsage && (
              <UsageStats usage={conversationUsage} label="Total:" />
            )}
          </div>
        )}

        {editingMsgId && (
          <div className="edit-banner">
            <span>Editing message</span>
            <button type="button" className="edit-banner-cancel" onClick={cancelEdit} title="Cancel edit">
              Cancel <FontAwesomeIcon icon={faXmark} />
            </button>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="attachment-tray">
            {attachments.map(att => (
              <div
                key={att.id}
                className={`attachment-tray-item${att.status === 'error' ? ' error' : att.status === 'uploading' ? ' uploading' : ''}`}
              >
                {att.attachmentKind === 'image' && (att.localUrl || att.url)
                  ? <img className="tray-thumbnail" src={att.localUrl ?? att.url} alt={att.filename} />
                  : <FontAwesomeIcon icon={faFile} className="tray-file-icon" />}
                <span className="tray-filename">{att.filename}</span>
                {att.status === 'uploading' && <FontAwesomeIcon icon={faSpinner} spin className="tray-spinner" />}
                {att.status === 'error' && <span className="tray-error" title={att.errorMsg}>!</span>}
                {att.attachmentKind === 'document' && att.status === 'ready' && (
                  <button
                    className={`tray-mode-btn${att.mode === 'rich' ? ' rich' : ''}`}
                    title={att.mode === 'rich' ? 'Rich (visual, more tokens)' : 'Standard (text only)'}
                    onClick={() => setAttachments(prev => prev.map(a =>
                      a.id === att.id ? { ...a, mode: a.mode === 'standard' ? 'rich' : 'standard' } : a,
                    ))}
                  >
                    <FontAwesomeIcon icon={att.mode === 'rich' ? faToggleOn : faToggleOff} />
                    {att.mode === 'rich' ? 'Rich' : 'Standard'}
                  </button>
                )}
                <button className="tray-remove" title="Remove" onClick={() => {
                  if (att.localUrl?.startsWith('blob:')) URL.revokeObjectURL(att.localUrl)
                  setAttachments(prev => prev.filter(a => a.id !== att.id))
                }}>
                  <FontAwesomeIcon icon={faXmark} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="input-bar">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={[...Object.keys(ALLOWED_TYPES), ...[...TEXT_EXTENSIONS].map(ext => `.${ext}`)].join(',')}
            style={{ display: 'none' }}
            onChange={e => {
              const files = Array.from(e.target.files ?? [])
              if (files.length > 0) addFiles(files)
              e.target.value = ''
            }}
          />
          <textarea
            ref={inputRef}
            className="message-input"
            rows={1}
            placeholder={isNew ? 'Start the conversation…' : 'Send a message…'}
            value={input}
            onChange={e => {
              setInput(e.target.value)
              const el = e.target
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`
            }}
            onKeyDown={e => {
              if (e.key !== 'Enter' || isMobileViewport()) return
              if (e.shiftKey) return // newline
              e.preventDefault()
              handleSend()
            }}
            onPaste={e => {
              const items = Array.from(e.clipboardData.items)
              const files = items
                .filter(item => item.kind === 'file')
                .map(item => item.getAsFile())
                .filter((f): f is File => f !== null)
              if (files.length > 0) {
                e.preventDefault()
                addFiles(files)
              }
            }}
            disabled={creatingChat}
            autoFocus
          />
          {(currentCaps?.attachments || currentCaps?.documents) && (
            <button
              className="btn-attach"
              title="Attach file"
              disabled={sending || creatingChat}
              onClick={() => fileInputRef.current?.click()}
            >
              <FontAwesomeIcon icon={faPaperclip} />
            </button>
          )}
          {sending ? (
            <button
              className="btn-send btn-stop"
              onClick={handleStop}
              title="Stop generating"
            >
              <FontAwesomeIcon icon={faStop} />
            </button>
          ) : (
            <button
              className="btn-send"
              onClick={() => handleSend()}
              disabled={creatingChat || (!input.trim() && attachments.filter(a => a.status === 'ready').length === 0)}
              title={isMobileViewport() ? 'Send' : 'Send (Enter to submit, Shift+Enter for a new line)'}
            >
              <FontAwesomeIcon icon={faPaperPlane} />
            </button>
          )}
        </div>
      </div>

      <ChatDetailsDialog
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        isNew={isNew}
        chat={activeChat ?? null}
        onRename={handleRenameChat}
        sensitive={sensitive}
        ephemeral={ephemeral}
        expiresAt={activeChat?.expiresAt}
        isProject={isChatInProject}
        onToggleSensitive={() => isNew ? setDraftSensitive(v => !v) : handleToggleFlag('sensitive')}
        onToggleEphemeral={() => isNew ? setDraftEphemeral(v => !v) : handleToggleFlag('ephemeral')}
        showTokenStats={effectiveShowTokenStats}
        onToggleShowTokenStats={() => handleChatSettingsChange({ ...draftModelSettings, showTokenStats: !effectiveShowTokenStats })}
        caps={currentCaps}
        settings={draftModelSettings}
        onSettingsChange={handleChatSettingsChange}
        systemPrompt={isNew ? draftSystemPrompt : (activeChat?.systemPrompt ?? '')}
        onSystemPromptChange={handleChatInstructionsChange}
        systemPromptSaveStatus={isNew ? undefined : systemPromptSaveStatus}
      />
    </div>
  )
}
