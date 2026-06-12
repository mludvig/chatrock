import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBars, faGear, faPaperPlane, faSpinner, faStop, faXmark, faChevronUp, faChevronDown, faPaperclip, faFile, faToggleOn, faToggleOff } from '@fortawesome/free-solid-svg-icons'
import { api, defaultSettings, migrateSettings, requestUpload, uploadToS3 } from '../api/http'
import type { Model, ModelSettings, ModelCapabilities, TokenUsage, Message, Step } from '../api/http'
import { parseSearchResults } from '../lib/toolResults'
import { sendMessage, cancelMessage, ensureConnected, setWSHandlers } from '../api/ws'
import type { WSEvent } from '../api/ws'
import { useChatStore } from '../store/chatStore'
import MessageBubble, { UsageStats } from './MessageBubble'
import ModelSettingsPanel from './ModelSettingsPanel'

interface Props {
  accessToken: string
  models: Model[]
  defaultModel: string
  onModelChange: (modelId: string) => void
  onOpenSidebar: () => void
}

export default function ChatView({ accessToken, models, defaultModel, onModelChange, onOpenSidebar }: Props) {
  const { chatId } = useParams<{ chatId?: string }>()
  const navigate = useNavigate()
  const isNew = !chatId || chatId === 'new'

  const {
    chats, messages, streamingMsg,
    setMessages, startStream, appendDelta, appendThinkingDelta, markThinkingDone,
    addToolCall, updateToolCallInput, resolveToolCall, setStreamUsage, finalizeStream, clearStream,
    renameChat, sending, setSending, updateChatSystemPrompt, pushToast,
  } = useChatStore()

  // For /c/new: local model + system prompt state (not yet persisted)
  const [newModel, setNewModel] = useState(defaultModel)
  const [newSystemPrompt, setNewSystemPrompt] = useState('')

  const [showSettings, setShowSettings] = useState(false)

  // Per-session model settings — derived from selected model's capabilities
  const [modelSettings, setModelSettings] = useState<ModelSettings>({})

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
  const stickToBottom = useRef(true)
  // bubble DOM refs for prev/next stepping (C3)
  const bubbleRefsRef = useRef<HTMLDivElement[]>([])
  const bubbleIdxRef = useRef(-1)
  const [showScrollDown, setShowScrollDown] = useState(false)
  // Ref so the WS done-handler can access the current chatId without stale closure
  const chatIdRef = useRef<string | undefined>(chatId)

  const activeChat = isNew ? null : chats.find(c => c.chatId === chatId)
  const currentModelId = isNew ? (newModel || defaultModel) : (activeChat?.model || defaultModel)
  const currentModelDef = models.find(m => m.id === currentModelId)
  const currentCaps: ModelCapabilities = currentModelDef?.capabilities
    ?? { temperature: true, topP: true, topK: false, thinking: 'none', attachments: true }

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

  function addFiles(files: File[]) {
    const currentChatId = chatId && chatId !== 'new' ? chatId : null
    if (!currentChatId) {
      pushToast({ kind: 'error', text: 'Start a chat before attaching files' })
      return
    }
    for (const file of files) {
      const ct = file.type || 'application/octet-stream'
      const kind = ALLOWED_TYPES[ct]
      if (!kind) {
        pushToast({ kind: 'error', text: `File type not supported: ${file.name}` })
        continue
      }
      const maxBytes = MAX_SIZES[ct] ?? 1 * 1024 * 1024
      if (file.size > maxBytes) {
        pushToast({ kind: 'error', text: `File too large: ${file.name}` })
        continue
      }
      const id = crypto.randomUUID()
      const localUrl = kind === 'image' ? URL.createObjectURL(file) : undefined
      const att: PendingAttachment = {
        id, file, contentType: ct, filename: file.name,
        attachmentKind: kind, mode: 'standard', localUrl, status: 'uploading',
      }
      setAttachments(prev => [...prev, att])

      requestUpload({ chatId: currentChatId, filename: file.name, contentType: ct, sizeBytes: file.size })
        .then(({ s3Key, uploadUrl }) => uploadToS3(uploadUrl, file).then(() => s3Key))
        .then(s3Key => {
          setAttachments(prev => prev.map(a => a.id === id ? { ...a, s3Key, status: 'ready' } : a))
        })
        .catch(e => {
          const msg = e instanceof Error ? e.message : String(e)
          setAttachments(prev => prev.map(a => a.id === id ? { ...a, status: 'error', errorMsg: msg } : a))
        })
    }
  }

  // Keep ref in sync after each render (must be an effect, not during render)
  useEffect(() => { chatIdRef.current = chatId })

  // Revoke object URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      attachments.forEach(a => { if (a.localUrl) URL.revokeObjectURL(a.localUrl) })
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
            return { ...step, searchResults: parseSearchResults(step.name, step.result, step.isError) }
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

  // Pre-fill input with a draft when navigating to the fork (set via pendingDraftRef before navigate)
  const pendingDraftRef = useRef<string | null>(null)
  useEffect(() => {
    if (pendingDraftRef.current) {
      setInput(pendingDraftRef.current)
      pendingDraftRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId])

  // Initialise modelSettings when the current model's capabilities are first known
  useEffect(() => {
    if (currentModelDef) {
      setModelSettings(s => {
        // Only re-initialise if settings are empty (first load or model change handled elsewhere)
        if (Object.keys(s).length === 0) return defaultSettings(currentModelDef.capabilities)
        return s
      })
    }
  }, [currentModelDef])

  // Register WS event handler
  useEffect(() => {
    setWSHandlers((evt: WSEvent) => {
      if (evt.type === 'delta') {
        appendDelta(evt.text)
      } else if (evt.type === 'thinking_delta') {
        appendThinkingDelta(evt.text)
      } else if (evt.type === 'thinking_done') {
        markThinkingDone()
      } else if (evt.type === 'tool_call_start') {
        addToolCall({ toolUseId: evt.toolUseId, name: evt.name, input: '' })
      } else if (evt.type === 'tool_call') {
        updateToolCallInput(evt.toolUseId, evt.input)
      } else if (evt.type === 'tool_result') {
        resolveToolCall(evt.toolUseId, evt.content ?? '', evt.isError)
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
      } else if (evt.type === 'error') {
        clearStream()
        setSending(false)
        setErrorMsg(evt.message)
      }
    })
  }, [appendDelta, appendThinkingDelta, markThinkingDone, addToolCall, updateToolCallInput, resolveToolCall, setStreamUsage, finalizeStream, clearStream, renameChat, setSending, reloadMessages])

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
            return { ...step, searchResults: parseSearchResults(step.name, step.result, step.isError) }
          }),
        }
      })
      setMessages(enriched)
      setConversationUsage(r.conversationUsage)
    }).catch(() => {
      if (!cancelled) navigate('/c/new', { replace: true })
    }).finally(() => {
      if (!cancelled) setLoadingMessages(false)
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, isNew])

  // Auto-scroll — only when stuck to bottom
  useEffect(() => {
    if (stickToBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, streamingMsg])

  // Reset stick + bubble refs when chat changes
  useEffect(() => {
    stickToBottom.current = true
    setShowScrollDown(false)
    bubbleRefsRef.current = []
    bubbleIdxRef.current = -1
  }, [chatId])

  function handleMessagesScroll() {
    const el = messagesRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stickToBottom.current = atBottom
    setShowScrollDown(!atBottom)
  }

  function scrollToBottom() {
    stickToBottom.current = true
    setShowScrollDown(false)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  function scrollToTop() {
    const el = messagesRef.current
    if (!el) return
    el.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function stepBubble(dir: 1 | -1) {
    const refs = bubbleRefsRef.current.filter(Boolean)
    if (refs.length === 0) return
    const next = Math.max(0, Math.min(refs.length - 1, bubbleIdxRef.current + dir))
    bubbleIdxRef.current = next
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
      const now = new Date().toISOString()
      useChatStore.getState().addChat({
        chatId: res.chatId,
        title: `${activeChat.title} (fork)`,
        model: activeChat.model,
        systemPrompt: activeChat.systemPrompt,
        createdAt: now,
        updatedAt: now,
      })
      pushToast({ kind: 'success', text: 'Forked into a new chat' })
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
    setSending(true)
    setErrorMsg(null)
    setLastTurnUsage(null)

    // Optimistic truncate: keep everything up to and including the user turn (parentId),
    // drop the old answer and any later messages from view.
    const cut = messages.findIndex(m => m.msgId === parentId)
    if (cut >= 0) setMessages(messages.slice(0, cut + 1))
    startStream()

    try {
      await ensureConnected(accessToken)
      sendMessage({
        chatId: chatId!,
        model: activeChat.model,
        systemPrompt: activeChat.systemPrompt,
        modelSettings,
        parentId,
      })
    } catch (err) {
      setSending(false)
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }, [activeChat, creatingChat, messages, chatId, accessToken, modelSettings, startStream])

  function handleStop() {
    // Optimistic: reset UI immediately so the input re-enables right away.
    // The server will honour the cancel asynchronously; the eventual 'cancelled'
    // WS event (if it arrives) is a no-op because sending is already false.
    finalizeStream()
    setSending(false)
    const currentId = chatIdRef.current
    if (currentId && currentId !== 'new') reloadMessages(currentId)
    cancelMessage()
  }

  async function handleSend() {
    const content = input.trim()
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

    if (isNew) {
      setCreatingChat(true)
      const model = newModel || defaultModel
      const systemPrompt = newSystemPrompt

      setSending(true)
      setMessages([optimisticUser])
      startStream()

      try {
        const res = await api.createChat(model, systemPrompt)
        const now = new Date().toISOString()
        useChatStore.getState().addChat({
          chatId: res.chatId,
          title: 'New Chat',
          model,
          systemPrompt,
          createdAt: now,
          updatedAt: now,
        })
        await ensureConnected(accessToken)
        sendMessage({ chatId: res.chatId, content, model, systemPrompt, modelSettings, attachments: attachmentsPayload })
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
      try {
        await ensureConnected(accessToken)
        sendMessage({
          chatId: chatId!,
          content,
          model: activeChat.model,
          systemPrompt: activeChat.systemPrompt,
          modelSettings,
          parentId: editPid,
          attachments: attachmentsPayload,
        })
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

    try {
      await ensureConnected(accessToken)
      sendMessage({
        chatId: chatId!,
        content,
        model: activeChat.model,
        systemPrompt: activeChat.systemPrompt,
        modelSettings,
        attachments: attachmentsPayload,
      })
    } catch (err) {
      setSending(false)
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }

  function handleModelChange(modelId: string) {
    onModelChange(modelId)
    const newCaps = models.find(m => m.id === modelId)?.capabilities
    if (newCaps) setModelSettings(s => migrateSettings(s, newCaps))

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

  function handleSystemPromptChange(value: string) {
    if (isNew) {
      setNewSystemPrompt(value)
    } else if (chatId) {
      updateChatSystemPrompt(chatId, value)
      api.updateSystemPrompt(chatId, value)
    }
  }

  const allMessages = [...messages, ...(streamingMsg ? [streamingMsg] : [])]

  return (
    <div className="chat-view">
      <div className="chat-header">
        <button className="btn-icon btn-hamburger" onClick={onOpenSidebar} title="Open sidebar">
          <FontAwesomeIcon icon={faBars} />
        </button>
        <h2>{isNew ? 'New Chat' : (activeChat?.title ?? 'Chat')}</h2>
        <div className="header-controls">
          <select
            className="model-select"
            value={currentModelId}
            onChange={e => handleModelChange(e.target.value)}
            disabled={sending}
          >
            {models.map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <button
            className={`btn-icon${showSettings ? ' active' : ''}`}
            onClick={() => setShowSettings(s => !s)}
            title="Chat settings"
          >
            <FontAwesomeIcon icon={faGear} />
          </button>
        </div>
      </div>

      {/* Settings panel — shown for both new and existing chats, live-apply */}
      {showSettings && (
        <div className={`settings-panel${isNew ? ' new-chat-settings' : ''}`}>
          <label>System prompt{isNew && <span className="hint"> (optional)</span>}</label>
          <textarea
            className="system-prompt-input"
            rows={isNew ? 2 : 4}
            placeholder="You are a helpful assistant…"
            value={isNew ? newSystemPrompt : (activeChat?.systemPrompt ?? '')}
            onChange={e => handleSystemPromptChange(e.target.value)}
          />
          <ModelSettingsPanel
            caps={currentCaps}
            settings={modelSettings}
            onChange={setModelSettings}
          />
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
            <div key={'msgId' in m ? m.msgId : `stream-${i}`} ref={el => { if (el) bubbleRefsRef.current[i] = el }} style={{ display: 'contents' }}>
              <MessageBubble
                message={m}
                onRerun={!isNew ? handleRerun : undefined}
                onNavigate={!isNew ? handleNavigate : undefined}
                onEditRequest={!isNew ? handleEditRequest : undefined}
                onForkToHere={!isNew ? handleForkToHere : undefined}
                onDeleteBranch={!isNew ? handleDeleteBranch : undefined}
              />
            </div>
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
        {/* Token stats line — shown when there are any usage stats */}
        {(lastTurnUsage || conversationUsage) && (
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
            accept={Object.keys(ALLOWED_TYPES).join(',')}
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
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            onPaste={e => {
              const items = Array.from(e.clipboardData.items)
              const files = items
                .filter(item => item.kind === 'file' && ALLOWED_TYPES[item.type])
                .map(item => item.getAsFile())
                .filter((f): f is File => f !== null)
              if (files.length > 0) {
                e.preventDefault()
                addFiles(files)
              }
            }}
            disabled={sending || creatingChat}
            autoFocus
          />
          {currentCaps?.attachments && (
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
              onClick={handleSend}
              disabled={creatingChat || (!input.trim() && attachments.filter(a => a.status === 'ready').length === 0)}
            >
              <FontAwesomeIcon icon={faPaperPlane} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
