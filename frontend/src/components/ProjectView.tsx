import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faPlus, faArrowRightFromBracket, faSpinner, faTrash,
  faUpload, faFile, faExclamationTriangle,
} from '@fortawesome/free-solid-svg-icons'
import { api, uploadToS3 } from '../api/http'
import type { Chat, ModelSettings, ProjectMemory, ProjectFile } from '../api/http'
import { useChatStore } from '../store/chatStore'

interface Props {
  defaultModel: string
}

export default function ProjectView({ defaultModel }: Props) {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const selectedFileId = searchParams.get('file')

  const { projects, updateProject, addChat, updateChatProjectId, pushToast, userPreferences, models, mergeProjectFiles } = useChatStore()
  const memoryRefreshTick = useChatStore(s => s.memoryRefreshTick)
  const project = projects.find(p => p.projectId === projectId)

  const [projectChats, setProjectChats] = useState<Chat[]>([])
  const [loading, setLoading] = useState(true)

  const [editingName, setEditingName] = useState(false)
  const [editName, setEditName] = useState('')

  const [projectMemories, setProjectMemories] = useState<ProjectMemory[]>([])
  const [memoriesLoading, setMemoriesLoading] = useState(true)

  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([])
  const [filesLoading, setFilesLoading] = useState(true)
  const [expandedSummaries, setExpandedSummaries] = useState<Set<string>>(new Set())
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!projectId) return
    setLoading(true)
    api.getProject(projectId)
      .then(res => { setProjectChats(res.chats) })
      .catch(() => { navigate('/c/new', { replace: true }) })
      .finally(() => setLoading(false))
  }, [projectId, navigate])

  useEffect(() => {
    if (!projectId) return
    setMemoriesLoading(true)
    api.listProjectMemory(projectId)
      .then(r => setProjectMemories(r.memories))
      .catch(() => {})
      .finally(() => setMemoriesLoading(false))
  }, [projectId, memoryRefreshTick])

  useEffect(() => {
    if (!projectId) return
    setFilesLoading(true)
    api.listProjectFiles(projectId)
      .then(r => { setProjectFiles(r.files); mergeProjectFiles(r.files) })
      .catch(() => {})
      .finally(() => setFilesLoading(false))
  }, [projectId, mergeProjectFiles])

  useEffect(() => {
    if (selectedFileId) {
      setExpandedSummaries(prev => new Set([...prev, selectedFileId]))
    }
  }, [selectedFileId])

  async function handleRename() {
    setEditingName(false)
    const name = editName.trim()
    if (!name || !projectId) return
    updateProject(projectId, { name })
    try {
      await api.updateProject(projectId, { name })
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleNewChat() {
    if (!projectId) return
    const model = userPreferences.defaultModel || defaultModel || models[0]?.id || ''
    try {
      const res = await api.createChat(model, '', undefined, undefined as ModelSettings | undefined, projectId)
      const now = new Date().toISOString()
      const newChat: Chat = { chatId: res.chatId, title: 'New Chat', model, systemPrompt: '', createdAt: now, updatedAt: now, projectId }
      addChat(newChat)
      setProjectChats(prev => [newChat, ...prev])
      navigate(`/c/${res.chatId}`)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleRemoveFromProject(e: React.MouseEvent, chatId: string) {
    e.stopPropagation()
    setProjectChats(prev => prev.filter(c => c.chatId !== chatId))
    updateChatProjectId(chatId, null)
    try {
      await api.moveChatToProject(chatId, null)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      api.getProject(projectId!).then(res => setProjectChats(res.chats)).catch(() => {})
    }
  }

  async function handleDeleteMemory(memId: string) {
    if (!projectId) return
    setProjectMemories(prev => prev.filter(m => m.memId !== memId))
    try {
      await api.deleteProjectMemory(projectId, memId)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      api.listProjectMemory(projectId).then(r => setProjectMemories(r.memories)).catch(() => {})
    }
  }

  async function handleUploadFile(file: File) {
    if (!projectId) return
    const localId = `local-${crypto.randomUUID()}`
    const now = new Date().toISOString()
    const optimistic: ProjectFile = {
      fileId: localId, filename: file.name, contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size, s3Key: '', status: 'uploading', inclusion: 'auto', createdAt: now, updatedAt: now,
    }
    setProjectFiles(prev => [optimistic, ...prev])
    try {
      const { fileId, s3Key, uploadUrl } = await api.requestProjectFileUpload(
        projectId, file.name, file.type || 'application/octet-stream', file.size,
      )
      setProjectFiles(prev => prev.map(f => f.fileId === localId ? { ...f, fileId, s3Key } : f))
      await uploadToS3(uploadUrl, file)
      setProjectFiles(prev => prev.map(f => f.fileId === fileId ? { ...f, status: 'processing' } : f))
      const { file: finalFile } = await api.finalizeProjectFile(projectId, fileId)
      setProjectFiles(prev => prev.map(f => f.fileId === fileId ? finalFile : f))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      pushToast({ kind: 'error', text: `Upload failed: ${msg}` })
      setProjectFiles(prev => prev.map(f => f.fileId === localId ? { ...f, status: 'error' } : f))
    }
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files) return
    Array.from(files).forEach(handleUploadFile)
    e.target.value = ''
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    Array.from(e.dataTransfer.files).forEach(handleUploadFile)
  }

  async function handleInclusionChange(fileId: string, inclusion: 'auto' | 'always' | 'never') {
    if (!projectId) return
    setProjectFiles(prev => prev.map(f => f.fileId === fileId ? { ...f, inclusion } : f))
    try {
      await api.setFileInclusion(projectId, fileId, inclusion)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      api.listProjectFiles(projectId).then(r => setProjectFiles(r.files)).catch(() => {})
    }
  }

  async function handleDeleteFile(e: React.MouseEvent, fileId: string) {
    e.stopPropagation()
    if (!projectId) return
    setProjectFiles(prev => prev.filter(f => f.fileId !== fileId))
    try {
      await api.deleteProjectFile(projectId, fileId)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      api.listProjectFiles(projectId).then(r => setProjectFiles(r.files)).catch(() => {})
    }
  }

  function toggleSummary(fileId: string) {
    setExpandedSummaries(prev => {
      const next = new Set(prev)
      if (next.has(fileId)) { next.delete(fileId) } else { next.add(fileId) }
      return next
    })
  }

  const memoryCategories: Array<ProjectMemory['category']> = ['decision', 'convention', 'fact', 'constraint', 'glossary', 'other']
  const groupedMemories = Object.fromEntries(
    memoryCategories.map(cat => [cat, projectMemories.filter(m => m.category === cat)])
  ) as Record<ProjectMemory['category'], ProjectMemory[]>

  const displayName = project?.name ?? 'Project'

  return (
    <div className="project-view">
      <div className="project-view-header">
        {editingName ? (
          <input
            autoFocus
            className="rename-input"
            style={{ flex: 1, fontSize: 18, fontWeight: 600 }}
            value={editName}
            onChange={e => setEditName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={e => {
              if (e.key === 'Enter') handleRename()
              if (e.key === 'Escape') setEditingName(false)
            }}
          />
        ) : (
          <h2 onClick={() => { setEditingName(true); setEditName(displayName) }} title="Click to rename">
            {displayName}
          </h2>
        )}
        <button className="btn-action" onClick={handleNewChat}>
          <FontAwesomeIcon icon={faPlus} /> New chat
        </button>
      </div>

      <div className="project-view-body">
        {/* ── Chats ── */}
        <div className="project-section">
          <div className="project-section-header">Chats</div>
          {loading ? (
            <div className="panel-loading"><FontAwesomeIcon icon={faSpinner} spin /> Loading…</div>
          ) : projectChats.length === 0 ? (
            <div className="panel-empty">No chats in this project yet.</div>
          ) : (
            projectChats.map(chat => (
              <div key={chat.chatId} className="chat-item" onClick={() => navigate(`/c/${chat.chatId}`)}>
                <div className="chat-item-content">
                  <span className="chat-title">{chat.title}</span>
                  {chat.summary && <span className="chat-summary">{chat.summary}</span>}
                </div>
                <div className="chat-actions">
                  <button onClick={e => handleRemoveFromProject(e, chat.chatId)} title="Remove from project">
                    <FontAwesomeIcon icon={faArrowRightFromBracket} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* ── Files ── */}
        <div className="project-section">
          <div className="project-section-header">
            <span>Files</span>
            <button className="btn-action btn-action--sm" onClick={() => fileInputRef.current?.click()}>
              <FontAwesomeIcon icon={faUpload} /> Upload
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileInputChange}
          />
          <div
            className={`project-drop-zone${dragOver ? ' drag-over' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            {filesLoading ? (
              <div className="panel-loading"><FontAwesomeIcon icon={faSpinner} spin /> Loading…</div>
            ) : projectFiles.length === 0 ? (
              <div className="panel-empty">Drop files here or click Upload</div>
            ) : (
              projectFiles.map(file => (
                <div key={file.fileId} className={`project-file-item${file.fileId === selectedFileId ? ' project-file-item--selected' : ''}`}>
                  <div className="project-file-main" onClick={() => file.summary && toggleSummary(file.fileId)}>
                    <FontAwesomeIcon icon={file.status === 'error' ? faExclamationTriangle : faFile}
                      className={`file-icon${file.status === 'error' ? ' file-icon--error' : ''}`} />
                    <div className="file-info">
                      <span className="file-name">{file.filename}</span>
                      {file.status === 'uploading' && (
                        <span className="file-status"><FontAwesomeIcon icon={faSpinner} spin /> uploading…</span>
                      )}
                      {file.status === 'processing' && (
                        <span className="file-status"><FontAwesomeIcon icon={faSpinner} spin /> processing…</span>
                      )}
                      {file.status === 'error' && (
                        <span className="file-status file-status--error">processing failed</span>
                      )}
                      {file.status === 'ready' && file.microLabel && (
                        <span className="file-micro-label">{file.microLabel}</span>
                      )}
                    </div>
                    <div className="file-actions">
                      {file.status === 'ready' && (
                        <select
                          className="inclusion-select"
                          value={file.inclusion}
                          onClick={e => e.stopPropagation()}
                          onChange={e => handleInclusionChange(file.fileId, e.target.value as 'auto' | 'always' | 'never')}
                          title="Inclusion mode"
                        >
                          <option value="auto">auto</option>
                          <option value="always">always</option>
                          <option value="never">never</option>
                        </select>
                      )}
                      <button className="file-delete" onClick={e => handleDeleteFile(e, file.fileId)} title="Delete file">
                        <FontAwesomeIcon icon={faTrash} />
                      </button>
                    </div>
                  </div>
                  {expandedSummaries.has(file.fileId) && file.summary && (
                    <div className="file-summary">{file.summary}</div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── Memory ── */}
        <div className="project-section">
          <div className="project-section-header">Memory</div>
          <p className="memory-hint">Project facts remembered here are shared across all chats in this project.</p>
          {memoriesLoading ? (
            <div className="panel-loading"><FontAwesomeIcon icon={faSpinner} spin /> Loading…</div>
          ) : projectMemories.length === 0 ? (
            <div className="panel-empty">No project memories yet. Chat in this project to build them up.</div>
          ) : (
            <div className="memory-list">
              {memoryCategories.map(cat => {
                const items = groupedMemories[cat]
                if (!items.length) return null
                return (
                  <div key={cat} className="memory-category">
                    <div className="memory-category-label">{cat}</div>
                    {items.map(mem => (
                      <div key={mem.memId} className="memory-item">
                        <span className="memory-text">{mem.text}</span>
                        <button className="memory-delete" title="Delete this memory" onClick={() => handleDeleteMemory(mem.memId)}>
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
      </div>
    </div>
  )
}
