import { useState } from 'react'
import { useNavigate, useMatch } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faFolderOpen, faPlus, faPenToSquare, faTrash } from '@fortawesome/free-solid-svg-icons'
import { api } from '../api/http'
import { useChatStore } from '../store/chatStore'

export default function ProjectsPanel() {
  const navigate = useNavigate()
  const match = useMatch('/p/:projectId')
  const activeProjectId = match?.params.projectId

  const { projects, addProject, updateProject, removeProject, pushToast } = useChatStore()

  const [showNewInput, setShowNewInput] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

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

  return (
    <div className="projects-panel">
      <div className="panel-header">
        <FontAwesomeIcon icon={faFolderOpen} />
        <span>Projects</span>
        <button
          className="panel-header-btn"
          title="New project"
          onClick={() => { setShowNewInput(true); setNewName('') }}
        >
          <FontAwesomeIcon icon={faPlus} />
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
        {projects.map(project => (
          <div
            key={project.projectId}
            className={`project-item${project.projectId === activeProjectId ? ' active' : ''}`}
            onClick={() => navigate(`/p/${project.projectId}`)}
          >
            {editingId === project.projectId ? (
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
            ) : (
              <>
                <FontAwesomeIcon icon={faFolderOpen} style={{ color: 'var(--accent, #4f6ef7)', fontSize: 13, flexShrink: 0 }} />
                <span className="project-title">{project.name}</span>
                <div className="project-actions">
                  <button onClick={e => startRename(e, project.projectId, project.name)} title="Rename">
                    <FontAwesomeIcon icon={faPenToSquare} />
                  </button>
                  <button onClick={e => handleDelete(e, project.projectId)} title="Delete">
                    <FontAwesomeIcon icon={faTrash} />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
