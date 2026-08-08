import { useState } from 'react'
import { useNavigate, useMatch } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faPenToSquare, faTrash, faWandMagicSparkles, faFolder, faFolderOpen, faFolderPlus } from '@fortawesome/free-solid-svg-icons'
import { api } from '../api/http'
import { useChatStore } from '../store/chatStore'
import { useChatActions } from '../lib/useChatActions'
import { sortByRecent } from '../lib/sort'
import ChatListFilter, { applyChatListFilter, useChatListFilter } from './ChatListFilter'

export default function ChatsPanel() {
  const navigate = useNavigate()
  const match = useMatch('/c/:chatId')
  const activeChatId = match?.params.chatId
  const { chats, pushToast, projects, addProject, updateChatProjectId } = useChatStore()
  const { editingId, setEditingId, editTitle, setEditTitle, retitling, handleRetitle, handleDelete, startRename, commitRename } = useChatActions()
  const [movingId, setMovingId] = useState<string | null>(null)
  const [creatingProjectFor, setCreatingProjectFor] = useState<string | null>(null)
  const [newProjectName, setNewProjectName] = useState('')
  const filter = useChatListFilter()

  function toggleMoveMenu(e: React.MouseEvent, chatId: string) {
    e.stopPropagation()
    setMovingId(prev => prev === chatId ? null : chatId)
    setCreatingProjectFor(null)
  }

  async function moveChat(chatId: string, projectId: string | null) {
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

  async function handleMove(e: React.MouseEvent, chatId: string, projectId: string | null) {
    e.stopPropagation()
    await moveChat(chatId, projectId)
  }

  function startCreateProject(e: React.MouseEvent, chatId: string) {
    e.stopPropagation()
    setCreatingProjectFor(chatId)
    setNewProjectName('')
  }

  // Lets the "Move to project" menu create-and-move in one step, instead of forcing a
  // detour through the Projects panel to create a project first.
  async function commitCreateProject(chatId: string) {
    const name = newProjectName.trim()
    setCreatingProjectFor(null)
    if (!name) return
    try {
      const res = await api.createProject(name)
      const now = new Date().toISOString()
      addProject({ projectId: res.projectId, name, createdAt: now, updatedAt: now })
      await moveChat(chatId, res.projectId)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  const sorted = sortByRecent(applyChatListFilter(chats, filter))

  return (
    <>
      <div className="chat-list-header">
        <ChatListFilter filter={filter} />
      </div>
      <div className="chat-list">
        {sorted.map(chat => {
          const chatProject = chat.projectId ? projects.find(p => p.projectId === chat.projectId) : null
          return (
            <div
              key={chat.chatId}
              className={`chat-item${chat.chatId === activeChatId ? ' active' : ''}${chat.sensitive ? ' sensitive' : ''}`}
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
                      {creatingProjectFor === chat.chatId ? (
                        <input
                          autoFocus
                          className="rename-input"
                          placeholder="Project name…"
                          value={newProjectName}
                          onChange={e => setNewProjectName(e.target.value)}
                          onBlur={() => commitCreateProject(chat.chatId)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') commitCreateProject(chat.chatId)
                            if (e.key === 'Escape') setCreatingProjectFor(null)
                          }}
                        />
                      ) : (
                        <div
                          className="move-menu-item move-menu-new"
                          onClick={e => startCreateProject(e, chat.chatId)}
                        >
                          <FontAwesomeIcon icon={faFolderPlus} style={{ marginRight: 6 }} />
                          New project…
                        </div>
                      )}
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
            {chats.length > 0
              ? 'No chats match the current filter. Adjust the filter above to see them.'
              : 'No chats yet. Click + to start.'}
          </p>
        )}
      </div>
    </>
  )
}
