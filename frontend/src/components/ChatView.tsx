import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faGear, faPaperPlane, faXmark } from '@fortawesome/free-solid-svg-icons'
import { api, defaultSettings, migrateSettings } from '../api/http'
import type { Model, ModelSettings, ModelCapabilities } from '../api/http'
import { sendMessage, ensureConnected, setWSHandlers } from '../api/ws'
import type { WSEvent } from '../api/ws'
import { useChatStore } from '../store/chatStore'
import MessageBubble from './MessageBubble'
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
    addToolCall, updateToolCallInput, resolveToolCall, finalizeStream, clearStream,
    renameChat, sending, setSending, updateChatSystemPrompt,
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

  const bottomRef = useRef<HTMLDivElement>(null)
  const streamBuf = useRef('')

  const activeChat = isNew ? null : chats.find(c => c.chatId === chatId)
  const currentModelId = isNew ? (newModel || defaultModel) : (activeChat?.model || defaultModel)
  const currentModelDef = models.find(m => m.id === currentModelId)
  const currentCaps: ModelCapabilities = currentModelDef?.capabilities
    ?? { temperature: true, topP: true, topK: false, thinking: 'none' }

  // Sync newModel when defaultModel resolves (models loaded async)
  useEffect(() => {
    if (isNew && defaultModel && !newModel) setNewModel(defaultModel)
  }, [defaultModel, isNew, newModel])

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
        streamBuf.current += evt.text
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
      } else if (evt.type === 'done') {
        const content = streamBuf.current
        streamBuf.current = ''
        finalizeStream(content)
        setSending(false)
      } else if (evt.type === 'titleUpdated') {
        renameChat(evt.chatId, evt.title)
      } else if (evt.type === 'error') {
        clearStream()
        setSending(false)
        setErrorMsg(evt.message)
      }
    })
  }, [appendDelta, appendThinkingDelta, markThinkingDone, addToolCall, updateToolCallInput, resolveToolCall, finalizeStream, clearStream, renameChat, setSending])

  // Load messages when chatId changes. Never re-run when sending changes — that would
  // overwrite in-progress optimistic state with stale DynamoDB records.
  useEffect(() => {
    if (isNew || !chatId) {
      setMessages([])
      return
    }
    let cancelled = false
    api.listMessages(chatId).then(r => { if (!cancelled) setMessages(r.messages) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, isNew])

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingMsg])

  async function handleSend() {
    const content = input.trim()
    if (!content || sending || creatingChat) return
    setInput('')
    setErrorMsg(null)

    if (isNew) {
      setCreatingChat(true)
      const model = newModel || defaultModel
      const systemPrompt = newSystemPrompt

      setSending(true)
      setMessages([
        { msgId: crypto.randomUUID(), role: 'user', content, model: '', createdAt: new Date().toISOString() },
      ])
      startStream()
      streamBuf.current = ''

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
      { msgId: crypto.randomUUID(), role: 'user', content, model: '', createdAt: new Date().toISOString() },
    ])
    startStream()
    streamBuf.current = ''

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

      <div className="messages">
        {allMessages.length === 0 && isNew && (
          <div className="chat-empty">
            <p>Type a message below to start the conversation.</p>
          </div>
        )}
        {allMessages.map((m, i) => (
          <MessageBubble
            key={'msgId' in m ? m.msgId : `stream-${i}`}
            message={m}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {errorMsg && (
        <div className="error-banner">
          <span><FontAwesomeIcon icon={faXmark} /> {errorMsg}</span>
          <button onClick={() => setErrorMsg(null)}>
            <FontAwesomeIcon icon={faXmark} />
          </button>
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
  )
}
