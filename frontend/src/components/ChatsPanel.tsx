import { useState } from 'react'
import { useNavigate, useMatch } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faPenToSquare, faTrash, faWandMagicSparkles } from '@fortawesome/free-solid-svg-icons'
import type { Chat } from '../api/http'
import { api } from '../api/http'
import { useChatStore } from '../store/chatStore'

interface Props {
  onRenameChat: (chatId: string, title: string) => void
}

export default function ChatsPanel({ onRenameChat }: Props) {
  const navigate = useNavigate()
  const match = useMatch('/c/:chatId')
  const activeChatId = match?.params.chatId
  const { chats, removeChat, pushToast } = useChatStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [retitling, setRetitling] = useState<string | null>(null)

  async function handleDelete(e: React.MouseEvent, chatId: string) {
    e.stopPropagation()
    if (!confirm('Delete this chat?')) return
    try {
      await api.deleteChat(chatId)
      removeChat(chatId)
      if (activeChatId === chatId) navigate('/c/new')
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  function startRename(e: React.MouseEvent, chat: Chat) {
    e.stopPropagation()
    setEditingId(chat.chatId)
    setEditTitle(chat.title)
  }

  async function commitRename(chatId: string) {
    const title = editTitle.trim()
    if (title) {
      await api.renameChat(chatId, title)
      onRenameChat(chatId, title)
    }
    setEditingId(null)
  }

  async function handleRetitle(e: React.MouseEvent, chatId: string) {
    e.stopPropagation()
    setRetitling(chatId)
    try {
      const res = await api.retitleChat(chatId)
      onRenameChat(chatId, res.title)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setRetitling(null)
    }
  }

  const sorted = [...chats].sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )

  return (
    <>
      <div className="chat-list">
        {sorted.map(chat => (
          <div
            key={chat.chatId}
            className={`chat-item${chat.chatId === activeChatId ? ' active' : ''}`}
            onClick={() => navigate(`/c/${chat.chatId}`)}
          >
            {editingId === chat.chatId ? (
              <input
                autoFocus
                className="rename-input"
                value={editTitle}
                onChange={e => setEditTitle(e.target.value)}
                onBlur={() => commitRename(chat.chatId)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename(chat.chatId)
                  if (e.key === 'Escape') setEditingId(null)
                }}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <>
                <span className="chat-title">{chat.title}</span>
                <div className="chat-actions">
                  <button
                    onClick={e => handleRetitle(e, chat.chatId)}
                    title="Re-generate title"
                    disabled={retitling === chat.chatId}
                  >
                    <FontAwesomeIcon icon={faWandMagicSparkles} spin={retitling === chat.chatId} />
                  </button>
                  <button onClick={e => startRename(e, chat)} title="Rename">
                    <FontAwesomeIcon icon={faPenToSquare} />
                  </button>
                  <button onClick={e => handleDelete(e, chat.chatId)} title="Delete">
                    <FontAwesomeIcon icon={faTrash} />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
        {chats.length === 0 && (
          <p className="empty-hint">No chats yet. Click + to start.</p>
        )}
      </div>
    </>
  )
}
