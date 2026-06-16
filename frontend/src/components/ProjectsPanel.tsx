import { useState } from 'react'
import { useNavigate, useMatch } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faFolderTree, faFolderOpen, faFolder, faFolderPlus,
  faPenToSquare, faTrash, faChevronRight, faChevronDown,
  faComment, faFile, faBrain, faSpinner,
} from '@fortawesome/free-solid-svg-icons'
import { api } from '../api/http'
import type { ProjectFile, ProjectMemory } from '../api/http'
import { useChatStore } from '../store/chatStore'

export default function ProjectsPanel() {
  const navigate = useNavigate()
  const matchProject = useMatch('/p/:projectId')
  const matchChat = useMatch('/c/:chatId')
  const activeProjectId = matchProject?.params.projectId

  const { projects, chats, addProject, updateProject, removeProject, pushToast, mergeProjectFiles } = useChatStore()

  const [showNewInput, setShowNewInput] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  // Tree expansion state
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
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

  function startRename(e: React.MouseEvent, projectId: string, name: string) {
    e.stopPropagation()
    setEditingId(projectId)
    setEditName(name)
  }

  async function commitRename(projectId: string) {
    const name = editName.trim()
    setEditingId(null)
    if (!name) return
    updateProject(projectId, { name })
    try {
      await api.updateProject(projectId, { name })
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleDelete(e: React.MouseEvent, projectId: string) {
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

  function toggleProject(e: React.MouseEvent, projectId: string) {
    e.stopPropagation()
    setExpandedProjects(prev => {
      const next = new Set(prev)
      if (next.has(projectId)) { next.delete(projectId) } else { next.add(projectId) }
      return next
    })
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
      // non-fatal: sub-sections just stay empty
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
          const isExpanded = expandedProjects.has(project.projectId)
          const sections = expandedSections[project.projectId] ?? new Set<'files' | 'memory'>()
          const projectChats = chats.filter(c => c.projectId === project.projectId)
          const files = loadedFiles[project.projectId] ?? []
          const memories = loadedMemories[project.projectId] ?? []
          const isLoading = loadingData.has(project.projectId)

          return (
            <div key={project.projectId} className="project-tree-item">
              {/* Project row */}
              {editingId === project.projectId ? (
                <div className="project-item project-item--editing">
                  <input
                    autoFocus
                    className="rename-input"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onBlur={() => commitRename(project.projectId)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename(project.projectId)
                      if (e.key === 'Escape') setEditingId(null)
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
                    onClick={e => toggleProject(e, project.projectId)}
                    title={isExpanded ? 'Collapse' : 'Expand'}
                  >
                    <FontAwesomeIcon icon={isExpanded ? faChevronDown : faChevronRight} />
                  </button>
                  <FontAwesomeIcon
                    icon={isExpanded ? faFolderOpen : faFolder}
                    className="project-folder-icon"
                  />
                  <span className="project-title">{project.name}</span>
                  <div className="project-actions">
                    <button onClick={e => startRename(e, project.projectId, project.name)} title="Rename">
                      <FontAwesomeIcon icon={faPenToSquare} />
                    </button>
                    <button onClick={e => handleDelete(e, project.projectId)} title="Delete">
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
                        <FontAwesomeIcon icon={faComment} className="project-chat-icon" />
                        <span className="project-chat-title">{chat.title}</span>
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
                          <div key={f.fileId} className="project-sub-item" title={f.summary ?? ''}>
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
