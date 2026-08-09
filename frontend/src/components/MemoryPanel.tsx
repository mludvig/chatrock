import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api/http'
import type { UserMemory } from '../api/http'
import { useChatStore } from '../store/chatStore'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faTrash, faBrain } from '@fortawesome/free-solid-svg-icons'

export default function MemoryPanel() {
  const [memories, setMemories] = useState<UserMemory[]>([])
  const [loading, setLoading] = useState(true)
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null)
  const [editMemoryText, setEditMemoryText] = useState('')
  const memoryRefreshTick = useChatStore(s => s.memoryRefreshTick)
  const pushToast = useChatStore(s => s.pushToast)
  const editTextareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-grow the edit box to roughly match the memory text's length instead of a
  // cramped single-line input; capped by .memory-edit-textarea's max-height (scrolls beyond that).
  useEffect(() => {
    const el = editTextareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [editingMemoryId, editMemoryText])

  // Load memories on mount and whenever memoryRefreshTick changes
  useEffect(() => {
    setLoading(true)
    api.listMemory()
      .then(r => setMemories(r.memories))
      .catch(() => {}) // silently ignore errors
      .finally(() => setLoading(false))
  }, [memoryRefreshTick])

  async function handleDelete(memId: string) {
    await api.deleteMemory(memId)
    setMemories(prev => prev.filter(m => m.memId !== memId))
  }

  function startMemoryEdit(e: React.MouseEvent, mem: UserMemory) {
    e.stopPropagation()
    setEditingMemoryId(mem.memId)
    setEditMemoryText(mem.text)
  }

  async function commitMemoryEdit(memId: string) {
    setEditingMemoryId(null)
    const text = editMemoryText.trim()
    const prev = memories.find(m => m.memId === memId)
    if (!text || prev?.text === text) return
    setMemories(ms => ms.map(m => m.memId === memId ? { ...m, text } : m))
    try {
      await api.updateMemory(memId, { text })
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      if (prev) setMemories(ms => ms.map(m => m.memId === memId ? prev : m))
    }
  }

  // Group by category
  const categories: Array<UserMemory['category']> = ['identity', 'preference', 'style', 'other']
  const grouped = Object.fromEntries(
    categories.map(cat => [cat, memories.filter(m => m.category === cat)])
  ) as Record<UserMemory['category'], UserMemory[]>

  return (
    <div className="memory-panel">
      <div className="panel-header">
        <FontAwesomeIcon icon={faBrain} />
        <span>Memory</span>
      </div>
      <p className="memory-hint">
        Ask in any chat to add, correct, or remove a memory (e.g. "remember I'm in Wellington" or "correct my location").
      </p>
      {loading ? (
        <div className="panel-loading">Loading…</div>
      ) : memories.length === 0 ? (
        <div className="panel-empty">No memories yet. Chat with the assistant to build up facts — just say "remember that…".</div>
      ) : (
        <div className="memory-list">
          {categories.map(cat => {
            const items = grouped[cat]
            if (!items.length) return null
            return (
              <div key={cat} className="memory-category">
                <div className="memory-category-label">{cat}</div>
                {items.map(mem => (
                  <div key={mem.memId} className="memory-item">
                    {editingMemoryId === mem.memId ? (
                      <textarea
                        autoFocus
                        ref={editTextareaRef}
                        className="memory-edit-textarea"
                        value={editMemoryText}
                        onChange={e => setEditMemoryText(e.target.value)}
                        onBlur={() => commitMemoryEdit(mem.memId)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitMemoryEdit(mem.memId) }
                          if (e.key === 'Escape') setEditingMemoryId(null)
                        }}
                      />
                    ) : (
                      <span className="memory-text" title="Click to edit" onClick={e => startMemoryEdit(e, mem)}>{mem.text}</span>
                    )}
                    <button
                      className="memory-delete"
                      title="Delete this memory"
                      onClick={() => handleDelete(mem.memId)}
                    >
                      <FontAwesomeIcon icon={faTrash} />
                    </button>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
