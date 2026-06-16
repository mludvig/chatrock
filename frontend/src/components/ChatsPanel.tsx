import { useState } from 'react'
import { useNavigate, useMatch } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faPenToSquare, faTrash, faWandMagicSparkles, faFolder, faFolderOpen, faLayerGroup } from '@fortawesome/free-solid-svg-icons'
import { api } from '../api/http'
import { useChatStore } from '../store/chatStore'
import { useChatActions } from '../lib/useChatActions'

export default function ChatsPanel() {
  const navigate = useNavigate()
  const match = useMatch('/c/:chatId')
  const activeChatId = match?.params.chatId
  const { chats, pushToast, projects, updateChatProjectId } = useChatStore()
  const { editingId, setEditingId, editTitle, setEditTitle, retitling, handleRetitle, handleDelete, startRename, commitRename } = useChatActions()
  const [movingId, setMovingId] = useState<string | null>(null)
  const [showProjectChats, setShowProjectChats] = useState(false)

  function toggleMoveMenu(e: React.MouseEvent, chatId: string) {
    e.stopPropagation()
    setMovingId(prev => prev === chatId ? null : chatId)
  }

  async function handleMove(e: React.MouseEvent, chatId: string, projectId: string | null) {
    e.stopPropagation()
    setMovingId(null)
    updateChatProjectId(chatId, projectId)
    try {
      await api.moveChatToProject(chatId, projectId)
    } catch (err) {
      const chat = chats.find(c => c.chatId === chatId)
      updateChatProjectId(chatId, chat?.projectId ?? null)
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  const sorted = [...chats]
    .filter(c => showProjectChats || !c.projectId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

  return (
    <>
      <div className="chat-list-header">
        <button
          className={`chat-filter-btn${showProjectChats ? ' active' : ''}`}
          onClick={() => setShowProjectChats(v => !v)}
          title={showProjectChats ? 'Hide project chats' : 'Show all chats including project chats'}
        >
          <FontAwesomeIcon icon={faLayerGroup} />
          {showProjectChats ? 'All chats' : 'Non-project only'}
        </button>
      </div>
      <div className="chat-list">
        {sorted.map(chat => {
          const chatProject = chat.projectId ? projects.find(p => p.projectId === chat.projectId) : null
          return (
            <div
              key={chat.chatId}
              className={`chat-item${chat.chatId === activeChatId ? ' active' : ''}`}
              style={{ position: 'relative', flexDirection: 'column', alignItems: 'stretch', gap: 2 }}
              onClick={() => { setMovingId(null); navigate(`/c/${chat.chatId}`) }}
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
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
                      <button
                        onClick={e => toggleMoveMenu(e, chat.chatId)}
                        title="Move to project"
                      >
                        <FontAwesomeIcon icon={faFolderOpen} />
                      </button>
                      <button onClick={e => handleDelete(e, chat.chatId)} title="Delete">
                        <FontAwesomeIcon icon={faTrash} />
                      </button>
                    </div>
                  </div>
                  {chatProject && (
                    <span
                      className="project-chip"
                      onClick={e => { e.stopPropagation(); navigate(`/p/${chat.projectId}`) }}
                    >
                      <FontAwesomeIcon icon={faFolder} /> {chatProject.name}
                    </span>
                  )}
                  {movingId === chat.chatId && (
                    <div className="move-menu" onClick={e => e.stopPropagation()}>
                      {projects.map(p => (
                        <div
                          key={p.projectId}
                          className={`move-menu-item${chat.projectId === p.projectId ? ' active' : ''}`}
                          onClick={e => handleMove(e, chat.chatId, p.projectId)}
                        >
                          <FontAwesomeIcon icon={faFolder} style={{ marginRight: 6 }} />
                          {p.name}
                        </div>
                      ))}
                      {projects.length === 0 && (
                        <div className="move-menu-item" style={{ color: '#6b7280' }}>No projects</div>
                      )}
                      {chat.projectId && (
                        <div
                          className="move-menu-item remove"
                          onClick={e => handleMove(e, chat.chatId, null)}
                        >
                          Remove from project
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}
        {sorted.length === 0 && (
          <p className="empty-hint">
            {showProjectChats
              ? 'No chats yet. Click + to start.'
              : chats.length > 0
                ? 'All chats are in projects. Toggle above to see them.'
                : 'No chats yet. Click + to start.'}
          </p>
        )}
      </div>
    </>
  )
}
