import React, { useEffect, useState } from 'react'
import { api } from '../api/http'
import type { UserMemory } from '../api/http'
import { useChatStore } from '../store/chatStore'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faTrash, faBrain } from '@fortawesome/free-solid-svg-icons'

export default function MemoryPanel() {
  const [memories, setMemories] = useState<UserMemory[]>([])
  const [loading, setLoading] = useState(true)
  const memoryRefreshTick = useChatStore(s => s.memoryRefreshTick)

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
      {loading ? (
        <div className="panel-loading">Loading…</div>
      ) : memories.length === 0 ? (
        <div className="panel-empty">No memories yet. Chat to build up facts.</div>
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
                    <span className="memory-text">{mem.text}</span>
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
