import { useState } from 'react'
import { useNavigate, useMatch } from 'react-router-dom'
import { api } from '../api/http'
import type { Chat } from '../api/http'
import { useChatStore } from '../store/chatStore'

export function useChatActions() {
  const { removeChat, renameChat, pushToast } = useChatStore()
  const navigate = useNavigate()
  const matchChat = useMatch('/c/:chatId')
  const activeChatId = matchChat?.params.chatId

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [retitling, setRetitling] = useState<string | null>(null)

  async function handleRetitle(e: React.MouseEvent, chatId: string) {
    e.stopPropagation()
    setRetitling(chatId)
    try {
      const res = await api.retitleChat(chatId)
      renameChat(chatId, res.title)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setRetitling(null)
    }
  }

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
      renameChat(chatId, title)
    }
    setEditingId(null)
  }

  return { editingId, setEditingId, editTitle, setEditTitle, retitling, handleRetitle, handleDelete, startRename, commitRename }
}
