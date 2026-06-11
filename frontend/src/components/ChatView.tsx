import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faGear, faPaperPlane, faSpinner, faXmark, faChevronUp, faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { api, defaultSettings, migrateSettings } from '../api/http'
import type { Model, ModelSettings, ModelCapabilities, TokenUsage } from '../api/http'
import { parseSearchResults } from '../lib/toolResults'
import { sendMessage, ensureConnected, setWSHandlers } from '../api/ws'
import type { WSEvent } from '../api/ws'
import { useChatStore } from '../store/chatStore'
import MessageBubble, { UsageStats } from './MessageBubble'
import ModelSettingsPanel from './ModelSettingsPanel'

interface Props {
  accessToken: string
  models: Model[]
  defaultModel: string
  onModelChange: (modelId: string) => void
}

export default function ChatView({ accessToken, models, defaultModel, onModelChange }: Props) {
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
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
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
    ?? { temperature: true, topP: true, topK: false, thinking: 'none' }

  // Keep ref in sync after each render (must be an effect, not during render)
  useEffect(() => { chatIdRef.current = chatId })

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
      } else if (evt.type === 'done') {
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

  async function handleNavigate(targetMsgId: string) {
    if (!chatId || isNew || sending) return
    try {
      await api.setActiveLeaf(chatId, targetMsgId)
      reloadMessages(chatId)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleDeleteBranch(msgId: string) {
    if (!chatId || isNew || sending) return
    try {
      await api.deleteBranch(chatId, msgId)
      reloadMessages(chatId)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleForkToHere(fromMsgId: string, role: 'user' | 'assistant', text: string) {
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
      // For a user bubble: pre-fill its text as a draft in the new chat
      if (role === 'user') pendingDraftRef.current = text
      navigate(`/c/${res.chatId}`)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleEditSubmit(msgId: string, parentId: string | null, editedContent: string) {
    if (!activeChat || useChatStore.getState().sending || creatingChat) return
    setSending(true)
    setErrorMsg(null)
    setLastTurnUsage(null)

    // Optimistic: drop the edited bubble and everything after it, insert new user bubble.
    const cut = messages.findIndex(m => 'msgId' in m && m.msgId === msgId)
    const base = cut >= 0 ? messages.slice(0, cut) : []
    const optimisticUser = {
      msgId: crypto.randomUUID(),
      role: 'user' as const,
      steps: [{ kind: 'text' as const, text: editedContent }],
      model: '',
      createdAt: new Date().toISOString(),
    }
    setMessages([...base, optimisticUser])
    startStream()

    try {
      await ensureConnected(accessToken)
      sendMessage({
        chatId: chatId!,
        content: editedContent,
        model: activeChat.model,
        systemPrompt: activeChat.systemPrompt,
        modelSettings,
        parentId,
      })
    } catch (err) {
      setSending(false)
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRerun(parentId: string) {
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
  }

  async function handleSend() {
    const content = input.trim()
    if (!content || sending || creatingChat) return
    setInput('')
    setErrorMsg(null)
    setLastTurnUsage(null)

    // Optimistic user bubble (format C: steps-based)
    const optimisticUser = {
      msgId: crypto.randomUUID(),
      role: 'user' as const,
      steps: [{ kind: 'text' as const, text: content }],
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
        sendMessage({ chatId: res.chatId, content, model, systemPrompt, modelSettings })
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
                onEdit={!isNew ? handleEditSubmit : undefined}
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

      <div className="input-area">
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

        <div className="input-bar">
          <textarea
            className="message-input"
            rows={3}
            placeholder={isNew ? 'Start the conversation…' : 'Send a message…'}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            disabled={sending || creatingChat}
            autoFocus
          />
          <button
            className="btn-send"
            onClick={handleSend}
            disabled={sending || creatingChat || !input.trim()}
          >
            <FontAwesomeIcon icon={faPaperPlane} />
          </button>
        </div>
      </div>
    </div>
  )
}
