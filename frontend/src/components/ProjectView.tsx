import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faPlus, faArrowRightFromBracket, faSpinner, faTrash,
  faUpload, faFile, faExclamationTriangle, faWandMagicSparkles, faGear,
} from '@fortawesome/free-solid-svg-icons'
import { api, uploadToS3 } from '../api/http'
import type { Chat, ModelSettings, ProjectMemory, ProjectFile } from '../api/http'
import { useChatStore } from '../store/chatStore'
import { sortByRecent } from '../lib/sort'
import { useSaveStatus } from '../lib/useSaveStatus'
import ChatListFilter, { applyChatListFilter, useChatListFilter } from './ChatListFilter'
import ProjectDetailsDialog from './ProjectDetailsDialog'

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
  const chatFilter = useChatListFilter()

  const [editingName, setEditingName] = useState(false)
  const [editName, setEditName] = useState('')

  const [projectMemories, setProjectMemories] = useState<ProjectMemory[]>([])
  const [memoriesLoading, setMemoriesLoading] = useState(true)

  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([])
  const [filesLoading, setFilesLoading] = useState(true)
  const [expandedSummaries, setExpandedSummaries] = useState<Set<string>>(new Set())
  const [resummarizingId, setResummarizingId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null)
  const [editMemoryText, setEditMemoryText] = useState('')
  const editMemoryTextareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-grow the edit box to roughly match the memory text's length instead of a
  // cramped single-line input; capped by .memory-edit-textarea's max-height (scrolls beyond that).
  useEffect(() => {
    const el = editMemoryTextareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [editingMemoryId, editMemoryText])

  const [editingFileSummaryId, setEditingFileSummaryId] = useState<string | null>(null)
  const [editFileSummaryText, setEditFileSummaryText] = useState('')
  const [editingFileLabelId, setEditingFileLabelId] = useState<string | null>(null)
  const [editFileLabelText, setEditFileLabelText] = useState('')

  const [editingChatSummaryId, setEditingChatSummaryId] = useState<string | null>(null)
  const [editChatSummaryText, setEditChatSummaryText] = useState('')

  const [descDraft, setDescDraft] = useState('')
  const [instrDraft, setInstrDraft] = useState('')
  const { status: descSaveStatus, track: trackDescSave } = useSaveStatus()
  const { status: instrSaveStatus, track: trackInstrSave } = useSaveStatus()
  const settingsInitRef = useRef<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const settingsDebounceRef = useRef<number | null>(null)

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

  useEffect(() => {
    return () => {
      if (settingsDebounceRef.current !== null) clearTimeout(settingsDebounceRef.current)
    }
  }, [])

  useEffect(() => {
    if (project && settingsInitRef.current !== project.projectId) {
      setDescDraft(project.description ?? '')
      setInstrDraft(project.instructions ?? '')
      settingsInitRef.current = project.projectId
    }
  }, [project])

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
    const model = project?.defaultModel || userPreferences.defaultModel || defaultModel || models[0]?.id || ''
    const initSettings = project?.modelSettings
    try {
      const res = await api.createChat(model, '', undefined, initSettings, projectId)
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
      await api.updateProjectFile(projectId, fileId, { inclusion })
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

  function startMemoryEdit(e: React.MouseEvent, mem: ProjectMemory) {
    e.stopPropagation()
    setEditingMemoryId(mem.memId)
    setEditMemoryText(mem.text)
  }

  async function commitMemoryEdit(memId: string) {
    setEditingMemoryId(null)
    if (!projectId) return
    const text = editMemoryText.trim()
    const prev = projectMemories.find(m => m.memId === memId)
    if (!text || prev?.text === text) return
    setProjectMemories(p => p.map(m => m.memId === memId ? { ...m, text } : m))
    try {
      await api.updateProjectMemory(projectId, memId, { text })
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      api.listProjectMemory(projectId).then(r => setProjectMemories(r.memories)).catch(() => {})
    }
  }

  function startFileSummaryEdit(e: React.MouseEvent, file: ProjectFile) {
    e.stopPropagation()
    setEditingFileSummaryId(file.fileId)
    setEditFileSummaryText(file.summary ?? '')
  }

  async function commitFileSummaryEdit(fileId: string) {
    setEditingFileSummaryId(null)
    if (!projectId) return
    const summary = editFileSummaryText.trim()
    const prev = projectFiles.find(f => f.fileId === fileId)
    if (!summary || prev?.summary === summary) return
    setProjectFiles(p => p.map(f => f.fileId === fileId ? { ...f, summary } : f))
    try {
      await api.updateProjectFile(projectId, fileId, { summary })
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      api.listProjectFiles(projectId).then(r => setProjectFiles(r.files)).catch(() => {})
    }
  }

  function startFileLabelEdit(e: React.MouseEvent, file: ProjectFile) {
    e.stopPropagation()
    setEditingFileLabelId(file.fileId)
    setEditFileLabelText(file.microLabel ?? '')
  }

  async function commitFileLabelEdit(fileId: string) {
    setEditingFileLabelId(null)
    if (!projectId) return
    const microLabel = editFileLabelText.trim()
    const prev = projectFiles.find(f => f.fileId === fileId)
    if (!microLabel || prev?.microLabel === microLabel) return
    setProjectFiles(p => p.map(f => f.fileId === fileId ? { ...f, microLabel } : f))
    try {
      await api.updateProjectFile(projectId, fileId, { microLabel })
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      api.listProjectFiles(projectId).then(r => setProjectFiles(r.files)).catch(() => {})
    }
  }

  function startChatSummaryEdit(e: React.MouseEvent, chat: Chat) {
    e.stopPropagation()
    setEditingChatSummaryId(chat.chatId)
    setEditChatSummaryText(chat.summary ?? '')
  }

  async function commitChatSummaryEdit(chatId: string) {
    setEditingChatSummaryId(null)
    const summary = editChatSummaryText.trim()
    const prev = projectChats.find(c => c.chatId === chatId)
    if (prev?.summary === summary) return
    setProjectChats(p => p.map(c => c.chatId === chatId ? { ...c, summary } : c))
    try {
      await api.updateChatSummary(chatId, { summary })
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      if (projectId) api.getProject(projectId).then(res => setProjectChats(res.chats)).catch(() => {})
    }
  }

  async function handleResummarize(e: React.MouseEvent, chatId: string) {
    e.stopPropagation()
    setResummarizingId(chatId)
    try {
      const res = await api.resummarizeChat(chatId)
      setProjectChats(p => p.map(c => c.chatId === chatId ? { ...c, summary: res.summary, topics: res.topics } : c))
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setResummarizingId(null)
    }
  }

  function handleDescriptionBlur() {
    if (!projectId) return
    const description = descDraft
    if (project?.description === description) return
    updateProject(projectId, { description })
    trackDescSave(api.updateProject(projectId, { description }))
  }

  function handleInstructionsBlur() {
    if (!projectId) return
    const instructions = instrDraft
    if (project?.instructions === instructions) return
    updateProject(projectId, { instructions })
    trackInstrSave(api.updateProject(projectId, { instructions }))
  }

  async function handleToggleMemoryEnabled() {
    if (!projectId || !project) return
    const memoryEnabled = !(project.memoryEnabled ?? true)
    updateProject(projectId, { memoryEnabled })
    try {
      await api.updateProject(projectId, { memoryEnabled })
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      updateProject(projectId, { memoryEnabled: !memoryEnabled })
    }
  }

  async function handleDefaultModelChange(modelId: string) {
    if (!projectId) return
    const defaultModel = modelId || undefined
    updateProject(projectId, { defaultModel })
    try {
      await api.updateProject(projectId, { defaultModel })
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  function handleModelSettingsChange(modelSettings: ModelSettings) {
    if (!projectId) return
    updateProject(projectId, { modelSettings })
    if (settingsDebounceRef.current !== null) clearTimeout(settingsDebounceRef.current)
    settingsDebounceRef.current = window.setTimeout(() => {
      api.updateProject(projectId, { modelSettings }).catch(err => {
        pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      })
    }, 800)
  }

  const memoryCategories: Array<ProjectMemory['category']> = ['decision', 'convention', 'fact', 'constraint', 'glossary', 'other']
  const groupedMemories = Object.fromEntries(
    memoryCategories.map(cat => [cat, projectMemories.filter(m => m.category === cat)])
  ) as Record<ProjectMemory['category'], ProjectMemory[]>

  const displayName = project?.name ?? 'Project'
  const projectModelDef = models.find(m => m.id === project?.defaultModel)
  const projectCaps = projectModelDef?.capabilities
    ?? { provider: 'bedrock-converse' as const, temperature: true, topP: true, topK: false, thinking: 'none' as const, attachments: true, documents: true, promptCaching: 'none' as const }

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
        <button className="btn-icon" onClick={() => setDetailsOpen(true)} title="Project details">
          <FontAwesomeIcon icon={faGear} />
        </button>
        <button className="btn-action" onClick={handleNewChat}>
          <FontAwesomeIcon icon={faPlus} /> New chat
        </button>
      </div>

      <div className="project-view-body">
        {/* ── Chats ── */}
        <div className="project-section">
          <div className="project-section-header">
            Chats
            <ChatListFilter filter={chatFilter} showProjectToggle={false} />
          </div>
          {loading ? (
            <div className="panel-loading"><FontAwesomeIcon icon={faSpinner} spin /> Loading…</div>
          ) : projectChats.length === 0 ? (
            <div className="panel-empty">No chats in this project yet.</div>
          ) : applyChatListFilter(projectChats, chatFilter, { includeProjectChats: true }).length === 0 ? (
            <div className="panel-empty">No chats match the current filter.</div>
          ) : (
            sortByRecent(applyChatListFilter(projectChats, chatFilter, { includeProjectChats: true })).map(chat => (
              <div key={chat.chatId} className={`chat-item${chat.sensitive ? ' sensitive' : ''}`} onClick={() => navigate(`/c/${chat.chatId}`)}>
                <div className="chat-item-content">
                  <span className="chat-title">{chat.title}</span>
                  {editingChatSummaryId === chat.chatId ? (
                    <textarea
                      autoFocus
                      className="inline-edit-textarea"
                      value={editChatSummaryText}
                      onChange={e => setEditChatSummaryText(e.target.value)}
                      onBlur={() => commitChatSummaryEdit(chat.chatId)}
                      onClick={e => e.stopPropagation()}
                      onKeyDown={e => {
                        if (e.key === 'Escape') setEditingChatSummaryId(null)
                      }}
                    />
                  ) : chat.summary ? (
                    <span className="chat-summary chat-summary--editable" title="Click to edit" onClick={e => startChatSummaryEdit(e, chat)}>
                      {chat.summary}
                    </span>
                  ) : (
                    <span className="chat-summary chat-summary--placeholder" title="Click to add a summary" onClick={e => startChatSummaryEdit(e, chat)}>
                      Add a summary…
                    </span>
                  )}
                  {chat.topics && chat.topics.length > 0 && (
                    <div className="topic-chips">
                      {chat.topics.map(topic => (
                        <span key={topic} className="topic-chip">{topic}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="chat-actions">
                  <button
                    onClick={e => handleResummarize(e, chat.chatId)}
                    title="Re-generate summary"
                    disabled={resummarizingId === chat.chatId}
                  >
                    <FontAwesomeIcon icon={faWandMagicSparkles} spin={resummarizingId === chat.chatId} />
                  </button>
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
                      {file.status === 'ready' && (
                        editingFileLabelId === file.fileId ? (
                          <input
                            autoFocus
                            className="rename-input"
                            value={editFileLabelText}
                            onChange={e => setEditFileLabelText(e.target.value)}
                            onBlur={() => commitFileLabelEdit(file.fileId)}
                            onClick={e => e.stopPropagation()}
                            onKeyDown={e => {
                              if (e.key === 'Enter') commitFileLabelEdit(file.fileId)
                              if (e.key === 'Escape') setEditingFileLabelId(null)
                            }}
                          />
                        ) : file.microLabel ? (
                          <span className="file-micro-label" title="Click to edit" onClick={e => startFileLabelEdit(e, file)}>
                            {file.microLabel}
                          </span>
                        ) : null
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
                    editingFileSummaryId === file.fileId ? (
                      <textarea
                        autoFocus
                        className="inline-edit-textarea"
                        value={editFileSummaryText}
                        onChange={e => setEditFileSummaryText(e.target.value)}
                        onBlur={() => commitFileSummaryEdit(file.fileId)}
                        onKeyDown={e => {
                          if (e.key === 'Escape') setEditingFileSummaryId(null)
                        }}
                      />
                    ) : (
                      <div className="file-summary" title="Click to edit" onClick={e => startFileSummaryEdit(e, file)}>
                        {file.summary}
                      </div>
                    )
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
                        {editingMemoryId === mem.memId ? (
                          <textarea
                            autoFocus
                            ref={editMemoryTextareaRef}
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

      <ProjectDetailsDialog
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        projectName={displayName}
        descDraft={descDraft}
        onDescChange={setDescDraft}
        onDescBlur={handleDescriptionBlur}
        descSaveStatus={descSaveStatus}
        instrDraft={instrDraft}
        onInstrChange={setInstrDraft}
        onInstrBlur={handleInstructionsBlur}
        instrSaveStatus={instrSaveStatus}
        models={models}
        defaultModel={project?.defaultModel ?? ''}
        onDefaultModelChange={handleDefaultModelChange}
        caps={projectCaps}
        settings={project?.modelSettings ?? {}}
        onSettingsChange={handleModelSettingsChange}
        memoryEnabled={project?.memoryEnabled !== false}
        onToggleMemory={handleToggleMemoryEnabled}
      />
    </div>
  )
}
