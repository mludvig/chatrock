import { useState } from 'react'
import { useNavigate, useMatch } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faFolderTree, faFolderOpen, faFolder, faFolderPlus,
  faPenToSquare, faTrash, faChevronRight, faChevronDown,
  faComment, faFile, faBrain, faSpinner, faPlus,
  faWandMagicSparkles,
} from '@fortawesome/free-solid-svg-icons'
import { api } from '../api/http'
import type { ProjectFile, ProjectMemory } from '../api/http'
import { useChatStore } from '../store/chatStore'
import { useChatActions } from '../lib/useChatActions'

export default function ProjectsPanel() {
  const navigate = useNavigate()
  const matchProject = useMatch('/p/:projectId')
  const activeProjectId = matchProject?.params.projectId

  const { projects, chats, addProject, updateProject, removeProject, pushToast, mergeProjectFiles, addChat, userPreferences, models } = useChatStore()
  const { editingId, setEditingId, editTitle, setEditTitle, retitling, handleRetitle, handleDelete, startRename, commitRename } = useChatActions()

  const [showNewInput, setShowNewInput] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null)
  const [editProjectName, setEditProjectName] = useState('')
  const [creatingChatInProject, setCreatingChatInProject] = useState<string | null>(null)

  // Sub-section state (per project)
  const [expandedSections, setExpandedSections] = useState<Record<string, Set<'files' | 'memory'>>>({})
  const [loadedFiles, setLoadedFiles] = useState<Record<string, ProjectFile[]>>({})
  const [loadedMemories, setLoadedMemories] = useState<Record<string, ProjectMemory[]>>({})
  const [loadingData, setLoadingData] = useState<Set<string>>(new Set())

  async function handleCreate() {
    const name = newName.trim()
    if (!name) { setShowNewInput(false); return }
    setShowNewInput(false)
    setNewName('')
    try {
      const res = await api.createProject(name)
      const now = new Date().toISOString()
      const project = { projectId: res.projectId, name, createdAt: now, updatedAt: now }
      addProject(project)
      navigate(`/p/${res.projectId}`)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  function startProjectRename(e: React.MouseEvent, projectId: string, name: string) {
    e.stopPropagation()
    setEditingProjectId(projectId)
    setEditProjectName(name)
  }

  async function commitProjectRename(projectId: string) {
    const name = editProjectName.trim()
    setEditingProjectId(null)
    if (!name) return
    updateProject(projectId, { name })
    try {
      await api.updateProject(projectId, { name })
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleDeleteProject(e: React.MouseEvent, projectId: string) {
    e.stopPropagation()
    if (!confirm('Delete project? Chats will not be deleted but will be removed from the project.')) return
    removeProject(projectId)
    if (activeProjectId === projectId) navigate('/c/new')
    try {
      await api.deleteProject(projectId)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleNewChatInProject(e: React.MouseEvent, projectId: string) {
    e.stopPropagation()
    setCreatingChatInProject(projectId)
    try {
      const model = userPreferences.defaultModel || models[0]?.id || ''
      const res = await api.createChat(model, '', undefined, undefined, projectId)
      const now = new Date().toISOString()
      addChat({ chatId: res.chatId, title: 'New Chat', model, systemPrompt: '', createdAt: now, updatedAt: now, projectId })
      navigate(`/c/${res.chatId}`)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setCreatingChatInProject(null)
    }
  }

  async function loadProjectData(projectId: string) {
    if (loadedFiles[projectId] !== undefined || loadingData.has(projectId)) return
    setLoadingData(prev => new Set(prev).add(projectId))
    try {
      const [filesRes, memoriesRes] = await Promise.all([
        api.listProjectFiles(projectId),
        api.listProjectMemory(projectId),
      ])
      setLoadedFiles(prev => ({ ...prev, [projectId]: filesRes.files }))
      setLoadedMemories(prev => ({ ...prev, [projectId]: memoriesRes.memories }))
      mergeProjectFiles(filesRes.files)
    } catch {
      // non-fatal
    } finally {
      setLoadingData(prev => { const s = new Set(prev); s.delete(projectId); return s })
    }
  }

  function toggleSection(e: React.MouseEvent, projectId: string, section: 'files' | 'memory') {
    e.stopPropagation()
    loadProjectData(projectId)
    setExpandedSections(prev => {
      const cur = new Set(prev[projectId] ?? [])
      if (cur.has(section)) { cur.delete(section) } else { cur.add(section) }
      return { ...prev, [projectId]: cur }
    })
  }

  const matchChat = useMatch('/c/:chatId')
  const activeChatId = matchChat?.params.chatId

  return (
    <div className="projects-panel">
      <div className="panel-header">
        <FontAwesomeIcon icon={faFolderTree} />
        <span>Projects</span>
        <button
          className="panel-header-btn"
          title="New project"
          onClick={() => { setShowNewInput(true); setNewName('') }}
        >
          <FontAwesomeIcon icon={faFolderPlus} />
        </button>
      </div>

      {showNewInput && (
        <div className="new-project-bar">
          <input
            autoFocus
            placeholder="Project name…"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onBlur={handleCreate}
            onKeyDown={e => {
              if (e.key === 'Enter') handleCreate()
              if (e.key === 'Escape') { setShowNewInput(false); setNewName('') }
            }}
          />
        </div>
      )}

      <div className="project-list">
        {projects.length === 0 && (
          <p className="empty-hint">No projects yet.</p>
        )}
        {projects.map(project => {
          const isExpanded = project.projectId === activeProjectId
          const sections = expandedSections[project.projectId] ?? new Set<'files' | 'memory'>()
          const projectChats = chats.filter(c => c.projectId === project.projectId)
          const files = loadedFiles[project.projectId] ?? []
          const memories = loadedMemories[project.projectId] ?? []
          const isLoading = loadingData.has(project.projectId)

          return (
            <div key={project.projectId} className="project-tree-item">
              {/* Project row */}
              {editingProjectId === project.projectId ? (
                <div className="project-item project-item--editing">
                  <input
                    autoFocus
                    className="rename-input"
                    value={editProjectName}
                    onChange={e => setEditProjectName(e.target.value)}
                    onBlur={() => commitProjectRename(project.projectId)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitProjectRename(project.projectId)
                      if (e.key === 'Escape') setEditingProjectId(null)
                    }}
                    onClick={e => e.stopPropagation()}
                  />
                </div>
              ) : (
                <div
                  className={`project-item${project.projectId === activeProjectId ? ' active' : ''}`}
                  onClick={() => navigate(`/p/${project.projectId}`)}
                >
                  <button
                    className="project-chevron"
                    onClick={e => { e.stopPropagation(); navigate(`/p/${project.projectId}`) }}
                    title={isExpanded ? 'View project' : 'Expand project'}
                  >
                    <FontAwesomeIcon icon={isExpanded ? faChevronDown : faChevronRight} />
                  </button>
                  <FontAwesomeIcon
                    icon={isExpanded ? faFolderOpen : faFolder}
                    className="project-folder-icon"
                  />
                  <span className="project-title">{project.name}</span>
                  <div className="project-actions">
                    <button
                      onClick={e => handleNewChatInProject(e, project.projectId)}
                      title="New chat in project"
                      disabled={creatingChatInProject === project.projectId}
                    >
                      <FontAwesomeIcon icon={creatingChatInProject === project.projectId ? faSpinner : faPlus} spin={creatingChatInProject === project.projectId} />
                    </button>
                    <button onClick={e => startProjectRename(e, project.projectId, project.name)} title="Rename project">
                      <FontAwesomeIcon icon={faPenToSquare} />
                    </button>
                    <button onClick={e => handleDeleteProject(e, project.projectId)} title="Delete project">
                      <FontAwesomeIcon icon={faTrash} />
                    </button>
                  </div>
                </div>
              )}

              {/* Expanded sub-tree */}
              {isExpanded && (
                <div className="project-subtree">
                  {/* Chats */}
                  {projectChats.length === 0 ? (
                    <div className="project-subtree-empty">No chats yet</div>
                  ) : (
                    projectChats.map(chat => (
                      <div
                        key={chat.chatId}
                        className={`project-chat-item${chat.chatId === activeChatId ? ' active' : ''}`}
                        onClick={() => navigate(`/c/${chat.chatId}`)}
                        title={chat.title}
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
                            <FontAwesomeIcon icon={faComment} className="project-chat-icon" />
                            <span className="project-chat-title">{chat.title}</span>
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
                    ))
                  )}

                  {/* Files section */}
                  <div
                    className="project-sub-header"
                    onClick={e => toggleSection(e, project.projectId, 'files')}
                  >
                    <FontAwesomeIcon icon={sections.has('files') ? faChevronDown : faChevronRight} className="project-sub-chevron" />
                    <FontAwesomeIcon icon={faFile} className="project-sub-icon" />
                    <span>Files{files.length > 0 ? ` (${files.length})` : ''}</span>
                    {isLoading && <FontAwesomeIcon icon={faSpinner} spin style={{ marginLeft: 'auto', opacity: 0.5 }} />}
                  </div>
                  {sections.has('files') && (
                    <div className="project-sub-items">
                      {files.length === 0 ? (
                        <div className="project-subtree-empty">{isLoading ? 'Loading…' : 'No files'}</div>
                      ) : (
                        files.map(f => (
                          <div
                            key={f.fileId}
                            className="project-sub-item project-sub-item--clickable"
                            title={f.summary ?? ''}
                            onClick={() => navigate(`/p/${project.projectId}?file=${f.fileId}`)}
                          >
                            <FontAwesomeIcon icon={faFile} style={{ opacity: 0.5, fontSize: 11 }} />
                            <span className="project-sub-item-name">{f.filename}</span>
                            {f.microLabel && <span className="project-sub-item-label">— {f.microLabel}</span>}
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  {/* Memory section */}
                  <div
                    className="project-sub-header"
                    onClick={e => toggleSection(e, project.projectId, 'memory')}
                  >
                    <FontAwesomeIcon icon={sections.has('memory') ? faChevronDown : faChevronRight} className="project-sub-chevron" />
                    <FontAwesomeIcon icon={faBrain} className="project-sub-icon" />
                    <span>Memory{memories.length > 0 ? ` (${memories.length})` : ''}</span>
                  </div>
                  {sections.has('memory') && (
                    <div className="project-sub-items">
                      {memories.length === 0 ? (
                        <div className="project-subtree-empty">{isLoading ? 'Loading…' : 'No memories'}</div>
                      ) : (
                        memories.map(m => (
                          <div key={m.memId} className="project-sub-item" title={m.category}>
                            <span className="project-sub-item-name">{m.text}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
