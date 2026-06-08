import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faGear, faPaperPlane, faXmark, faCheck } from '@fortawesome/free-solid-svg-icons'
import { api } from '../api/http'
import type { Model } from '../api/http'
import { sendMessage, ensureConnected, setWSHandlers } from '../api/ws'
import type { WSEvent } from '../api/ws'
import { useChatStore } from '../store/chatStore'

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
    setMessages, appendDelta, finalizeStream, clearStream,
    renameChat, sending, setSending, updateChatSystemPrompt,
  } = useChatStore()

  // For /c/new: local model + system prompt state (not yet persisted)
  const [newModel, setNewModel] = useState(defaultModel)
  const [newSystemPrompt, setNewSystemPrompt] = useState('')

  // For existing chats
  const [editingSystemPrompt, setEditingSystemPrompt] = useState('')
  const [showSettings, setShowSettings] = useState(false)

  const [input, setInput] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [creatingChat, setCreatingChat] = useState(false)

  const bottomRef = useRef<HTMLDivElement>(null)
  const streamBuf = useRef('')

  const activeChat = isNew ? null : chats.find(c => c.chatId === chatId)

  // Sync newModel when defaultModel resolves (models loaded async)
  useEffect(() => {
    if (isNew && defaultModel && !newModel) setNewModel(defaultModel)
  }, [defaultModel, isNew, newModel])

  // Register WS event handler
  useEffect(() => {
    setWSHandlers((evt: WSEvent) => {
      if (evt.type === 'delta') {
        streamBuf.current += evt.text
        appendDelta(evt.text)
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
  }, [appendDelta, finalizeStream, clearStream, renameChat, setSending])

  // Load messages when navigating to an existing chat
  useEffect(() => {
    if (isNew || !chatId) {
      setMessages([])
      return
    }
    api.listMessages(chatId).then(r => setMessages(r.messages))
  }, [chatId, isNew, setMessages])

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
      // Create the chat server-side first, then send
      setCreatingChat(true)
      const model = newModel || defaultModel
      const systemPrompt = newSystemPrompt

      // Optimistically show the user message
      setSending(true)
      setMessages([
        { msgId: crypto.randomUUID(), role: 'user', content, model: '', createdAt: new Date().toISOString() },
      ])
      streamBuf.current = ''

      try {
        // onChatCreated creates the chat + navigates to /c/:chatId
        // We need to send the WS message after navigation — handle via a one-shot flag
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
        sendMessage({ chatId: res.chatId, content, model, systemPrompt })
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
    streamBuf.current = ''

    setMessages([
      ...messages,
      { msgId: crypto.randomUUID(), role: 'user', content, model: '', createdAt: new Date().toISOString() },
    ])

    try {
      await ensureConnected(accessToken)
      sendMessage({
        chatId: chatId!,
        content,
        model: activeChat.model,
        systemPrompt: activeChat.systemPrompt,
      })
    } catch (err) {
      setSending(false)
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }

  function handleModelChange(modelId: string) {
    onModelChange(modelId)
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

  async function saveSystemPrompt() {
    if (!chatId || isNew) return
    await api.updateSystemPrompt(chatId, editingSystemPrompt)
    updateChatSystemPrompt(chatId, editingSystemPrompt)
    setShowSettings(false)
  }

  const currentModel = isNew ? (newModel || defaultModel) : (activeChat?.model || defaultModel)
  const allMessages = [...messages, ...(streamingMsg ? [streamingMsg] : [])]

  return (
    <div className="chat-view">
      <div className="chat-header">
        <h2>{isNew ? 'New Chat' : (activeChat?.title ?? 'Chat')}</h2>
        <div className="header-controls">
          <select
            className="model-select"
            value={currentModel}
            onChange={e => handleModelChange(e.target.value)}
            disabled={sending}
          >
            {models.map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          {!isNew && (
            <button
              className={`btn-icon${showSettings ? ' active' : ''}`}
              onClick={() => {
                setEditingSystemPrompt(activeChat?.systemPrompt ?? '')
                setShowSettings(s => !s)
              }}
              title="Chat settings"
            >
              <FontAwesomeIcon icon={faGear} />
            </button>
          )}
        </div>
      </div>

      {/* System prompt editor for /c/new — shown inline above messages */}
      {isNew && (
        <div className="settings-panel new-chat-settings">
          <label>System prompt <span className="hint">(optional)</span></label>
          <textarea
            className="system-prompt-input"
            rows={2}
            placeholder="You are a helpful assistant…"
            value={newSystemPrompt}
            onChange={e => setNewSystemPrompt(e.target.value)}
          />
        </div>
      )}

      {/* Settings panel for existing chats */}
      {!isNew && showSettings && (
        <div className="settings-panel">
          <label>System prompt</label>
          <textarea
            className="system-prompt-input"
            rows={4}
            placeholder="You are a helpful assistant…"
            value={editingSystemPrompt}
            onChange={e => setEditingSystemPrompt(e.target.value)}
          />
          <div className="settings-actions">
            <button className="btn-icon" onClick={() => setShowSettings(false)} title="Cancel">
              <FontAwesomeIcon icon={faXmark} />
              <span>Cancel</span>
            </button>
            <button className="btn-primary btn-sm" onClick={saveSystemPrompt}>
              <FontAwesomeIcon icon={faCheck} />
              <span>Save</span>
            </button>
          </div>
        </div>
      )}

      <div className="messages">
        {allMessages.length === 0 && isNew && (
          <div className="chat-empty">
            <p>Type a message below to start the conversation.</p>
          </div>
        )}
        {allMessages.map((m, i) => (
          <div key={'msgId' in m ? m.msgId : `stream-${i}`} className={`message ${m.role}`}>
            <div className="message-content">
              {m.content}
              {'streaming' in m && <span className="cursor">▋</span>}
            </div>
          </div>
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
          autoFocus={isNew}
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
