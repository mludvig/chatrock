import { useEffect, useRef, useState } from 'react'
import { api } from '../api/http'
import { sendMessage, ensureConnected, setWSHandlers } from '../api/ws'
import type { WSEvent } from '../api/ws'
import { useChatStore } from '../store/chatStore'

interface Props {
  accessToken: string
}

export default function ChatView({ accessToken }: Props) {
  const {
    activeChatId, chats, messages, streamingMsg,
    setMessages, appendDelta, finalizeStream, clearStream,
    renameChat, sending, setSending,
  } = useChatStore()

  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const streamBuf = useRef('')

  const activeChat = chats.find(c => c.chatId === activeChatId)

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
      }
    })
  }, [appendDelta, finalizeStream, clearStream, renameChat, setSending])

  // Load messages when active chat changes
  useEffect(() => {
    if (!activeChatId) return
    api.listMessages(activeChatId).then(r => setMessages(r.messages))
  }, [activeChatId, setMessages])

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingMsg])

  async function handleSend() {
    const content = input.trim()
    if (!content || !activeChatId || !activeChat || sending) return
    setInput('')
    setSending(true)
    streamBuf.current = ''

    // Optimistically add user message
    setMessages([
      ...messages,
      { msgId: crypto.randomUUID(), role: 'user', content, model: '', createdAt: new Date().toISOString() },
    ])

    try {
      await ensureConnected(accessToken)
      sendMessage({
        chatId: activeChatId,
        content,
        model: activeChat.model,
        systemPrompt: activeChat.systemPrompt,
      })
    } catch {
      setSending(false)
    }
  }

  if (!activeChatId) {
    return (
      <div className="chat-empty">
        <p>Select a chat from the sidebar or create a new one.</p>
      </div>
    )
  }

  const allMessages = [
    ...messages,
    ...(streamingMsg ? [streamingMsg] : []),
  ]

  return (
    <div className="chat-view">
      <div className="chat-header">
        <h2>{activeChat?.title ?? 'Chat'}</h2>
        {activeChat?.model && <span className="model-badge">{activeChat.model.split('.').pop()}</span>}
      </div>

      <div className="messages">
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

      <div className="input-bar">
        <textarea
          className="message-input"
          rows={3}
          placeholder="Send a message…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          disabled={sending}
        />
        <button
          className="btn-send"
          onClick={handleSend}
          disabled={sending || !input.trim()}
        >
          {sending ? '…' : '↑'}
        </button>
      </div>
    </div>
  )
}
