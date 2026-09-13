import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, uploadToS3, type ModelSettings, type ProjectFile, type ProjectMemory } from '../api/http'
import { useChatStore } from '../store/chatStore'
import { sortByRecent } from '../lib/sort'
import { useSaveStatus } from '../lib/useSaveStatus'
import Dialog from './Dialog'
import ProjectDetailsDialog from './ProjectDetailsDialog'
import ChatListFilter, { applyChatListFilter, useChatListFilter } from './ChatListFilter'
import ItemMenu from './ItemMenu'

export default function ProjectView({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const { projectId = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { projects, chats, models, updateProject, patchChat, updateChatProjectId, mergeProjectFiles, bumpNewChatTick, memoryRefreshTick, pushToast, userPreferences } = useChatStore()
  const project = projects.find(p => p.projectId === projectId)
  const [tab, setTab] = useState('chats')
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [memories, setMemories] = useState<ProjectMemory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [details, setDetails] = useState(false)
  const [addChats, setAddChats] = useState(false)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const previousProjectText = useRef({ projectId: '', description: '', instructions: '' })
  const [edit, setEdit] = useState<{ kind: 'memory' | 'file' | 'name'; id: string; text: string } | null>(null)
  const [newFact, setNewFact] = useState(false)
  const [fact, setFact] = useState('')
  const [pending, setPending] = useState(false)
  const filter = useChatListFilter()
  const fileInput = useRef<HTMLInputElement>(null)
  const activeUploads = useRef(new Set<string>())
  const uploadFailures = useRef(new Map<string, string>())
  const currentProject = useRef(projectId)
  useEffect(() => { currentProject.current = projectId }, [projectId])
  const { status: descStatus, track: trackDesc } = useSaveStatus()
  const { status: instrStatus, track: trackInstr } = useSaveStatus()

  const refresh = useCallback(async () => {
    try {
      const [detail, fileRes, memoryRes] = await Promise.all([api.getProject(projectId), api.listProjectFiles(projectId), api.listProjectMemory(projectId)])
      if (currentProject.current !== projectId) return
      updateProject(projectId, detail.project)
      for (const chat of detail.chats) patchChat(chat.chatId, chat)
      // Reconcile membership too, including moves from another device.
      const ids = new Set(detail.chats.map(c => c.chatId))
      useChatStore.setState(s => ({ chats: [
        ...s.chats.filter(c => !ids.has(c.chatId)).map(c => c.projectId === projectId ? { ...c, projectId: undefined } : c),
        ...detail.chats,
      ] }))
      const refreshedFiles = fileRes.files.map(file => {
        const key = `${projectId}/${file.fileId}`
        if (file.status === 'ready') uploadFailures.current.delete(key)
        const failure = uploadFailures.current.get(key)
        return failure ? { ...file, status: 'error' as const, errorMessage: failure } : file
      })
      setFiles(previous => [
        ...previous.filter(file => activeUploads.current.has(`${projectId}/${file.fileId}`) && !refreshedFiles.some(f => f.fileId === file.fileId)),
        ...refreshedFiles,
      ])
      mergeProjectFiles(refreshedFiles); setMemories(memoryRes.memories); setError('')
    } catch (e) { if (currentProject.current === projectId) setError(`Could not load this project. ${String(e)}`) }
    finally { if (currentProject.current === projectId) setLoading(false) }
  }, [projectId, updateProject, patchChat, mergeProjectFiles])
  useEffect(() => {
    currentProject.current = projectId
    setLoading(true); setFiles([]); setMemories([]); setDraft(''); setQuery(''); setActionError('')
    void refresh()
    return () => { currentProject.current = '' }
  }, [refresh, projectId])
  useEffect(() => { void refresh() }, [memoryRefreshTick, refresh])
  useEffect(() => {
    const previous = previousProjectText.current
    const next = { projectId, description: project?.description ?? '', instructions: project?.instructions ?? '' }
    // Resume refreshes may update metadata while the user is typing; retain those edits.
    setDescription(value => previous.projectId !== projectId || value === previous.description ? next.description : value)
    setInstructions(value => previous.projectId !== projectId || value === previous.instructions ? next.instructions : value)
    previousProjectText.current = next
  }, [project?.description, project?.instructions, projectId])
  useEffect(() => {
    if (params.get('file')) setTab('knowledge')
    if (params.get('settings')) setDetails(true)
  }, [params])
  const busyFiles = files.some(f => f.status === 'uploading' || f.status === 'processing')
  // Durable file status is pulled on resume and while processing. See docs/realtime-reliability.md.
  useEffect(() => {
    const resume = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    const timer = busyFiles ? window.setInterval(resume, 5000) : undefined
    return () => { clearInterval(timer); window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume) }
  }, [busyFiles, refresh])
  useEffect(() => {
    if (tab === 'knowledge' && params.get('file')) document.getElementById(`file-${params.get('file')}`)?.scrollIntoView({ block: 'center' })
  }, [tab, params, files])

  async function action(fn: () => Promise<unknown>) {
    setPending(true); setActionError('')
    try { await fn(); await refresh(); return true }
    catch (e) { setActionError(String(e)); return false }
    finally { setPending(false) }
  }
  async function save(fields: Parameters<typeof api.updateProject>[1]) {
    await api.updateProject(projectId, fields)
    updateProject(projectId, { ...fields, defaultModel: fields.defaultModel === null ? undefined : fields.defaultModel ?? project?.defaultModel })
  }
  function startChat(e?: React.FormEvent) {
    e?.preventDefault(); bumpNewChatTick()
    navigate(`/c/new?project=${projectId}`, { state: { draft } })
  }
  async function upload(file: File) {
    const target = projectId
    let id = `local-${crypto.randomUUID()}`
    activeUploads.current.add(`${target}/${id}`)
    const now = new Date().toISOString()
    const row: ProjectFile = { fileId: id, filename: file.name, contentType: file.type || 'application/octet-stream', sizeBytes: file.size, s3Key: '', status: 'uploading', inclusion: 'auto', createdAt: now, updatedAt: now }
    setFiles(prev => [row, ...prev])
    try {
      const res = await api.requestProjectFileUpload(target, file.name, row.contentType, file.size)
      const oldId = id; id = res.fileId
      activeUploads.current.delete(`${target}/${oldId}`)
      activeUploads.current.add(`${target}/${id}`)
      if (currentProject.current === target) setFiles(prev => prev.map(f => f.fileId === oldId ? { ...f, fileId: id, s3Key: res.s3Key } : f))
      await uploadToS3(res.uploadUrl, file)
      if (currentProject.current === target) setFiles(prev => prev.map(f => f.fileId === id ? { ...f, status: 'processing' } : f))
      await api.finalizeProjectFile(target, id)
      if (currentProject.current === target) await refresh()
    } catch (e) {
      if (currentProject.current !== target) return
      setActionError(`Upload failed for ${file.name}: ${String(e)}. Retry processing, or remove it and upload again.`)
      uploadFailures.current.set(`${target}/${id}`, String(e))
      setFiles(prev => prev.map(f => f.fileId === id ? { ...f, status: 'error', errorMessage: String(e) } : f))
    } finally {
      activeUploads.current.delete(`${target}/${id}`)
    }
  }
  const projectChats = sortByRecent(applyChatListFilter(chats.filter(c => c.projectId === projectId), filter, { includeProjectChats: true }))
  const matchingChats = projectChats.filter(c => `${c.title} ${c.summary ?? ''} ${c.topics?.join(' ') ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  return <div className="project-view">
    <header className="project-view-header">
      <button className="btn-icon btn-hamburger" onClick={onOpenSidebar} title="Open sidebar">☰</button>
      <h2>{project?.name ?? 'Project'}</h2>
      <ItemMenu label="Project actions"><button onClick={() => setEdit({ kind: 'name', id: projectId, text: project?.name ?? '' })}>Rename project</button><button onClick={() => setDetails(true)}>Project settings</button></ItemMenu>
      <button className="btn-action" onClick={() => startChat()}>+ New chat</button>
    </header>
    <div className="project-view-body">
      {error && <div className="error-banner" role="alert">{error} <button onClick={() => refresh()}>Retry</button></div>}
      {actionError && <div className="error-banner" role="alert">{actionError} <button onClick={() => setActionError('')}>Dismiss</button></div>}
      {project?.description && <p className="project-description">{project.description}</p>}
      <form className="project-composer" onSubmit={startChat}>
        <label htmlFor="project-question">What would you like to work on?</label>
        <textarea id="project-question" placeholder="Start a conversation using this project’s knowledge…" value={draft} onChange={e => setDraft(e.target.value)} />
        <button className="btn-primary" type="submit">Start chat →</button>
      </form>
      <nav className="project-tabs" aria-label="Project sections"><button aria-pressed={tab === 'chats'} onClick={() => setTab('chats')}>Chats ({projectChats.length})</button><button aria-pressed={tab === 'knowledge'} onClick={() => setTab('knowledge')}>Knowledge ({files.length + memories.length})</button></nav>
      {loading && <p role="status">Loading project…</p>}
      {tab === 'chats' ? <section className="project-section">
        <div className="section-toolbar"><input className="search-field" aria-label="Filter project chats" placeholder="Filter chats…" value={query} onChange={e => setQuery(e.target.value)} /><button className="btn-action" onClick={() => setAddChats(true)}>Add existing chats</button><ChatListFilter filter={filter} showProjectToggle={false} /></div>
        {!loading && !matchingChats.length && <p className="panel-empty">No chats here yet. Start a conversation or add an existing chat.</p>}
        {matchingChats.map(c => <div key={c.chatId} className="chat-item project-chat-row"><Link className="chat-item-content" to={`/c/${c.chatId}`}><strong>{c.sensitive ? 'Private chat' : c.title}</strong>{!c.sensitive && c.summary && <span className="chat-summary">{c.summary}</span>}<small>{new Date(c.updatedAt).toLocaleDateString()}</small></Link><ItemMenu label={`Actions for ${c.title}`}><button onClick={() => action(async () => { await api.moveChatToProject(c.chatId, null); updateChatProjectId(c.chatId, null) })}>Remove from project</button><button onClick={() => navigate(`/c/${c.chatId}`)}>Open chat</button></ItemMenu></div>)}
      </section> : <div className="knowledge-sections">
        <section className="project-section"><div className="project-section-header">Instructions<button className="btn-action" onClick={() => setDetails(true)}>Edit</button></div><p className="knowledge-instructions">{project?.instructions || 'Tell the assistant how to work in this project. Instructions apply to every chat.'}</p></section>
        <section className="project-section" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); Array.from(e.dataTransfer.files).forEach(f => void upload(f)) }}>
          <div className="project-section-header">Files<button className="btn-action" onClick={() => fileInput.current?.click()}>Upload files</button></div>
          <p className="memory-hint">Available when relevant. Drop files here to share them across project chats.</p>
          <input ref={fileInput} type="file" multiple hidden onChange={e => { Array.from(e.target.files ?? []).forEach(f => void upload(f)); e.target.value = '' }} />
          {!files.length && <p className="panel-empty">Add notes, documents or reference material.</p>}
          {files.map(f => <article id={`file-${f.fileId}`} key={f.fileId} className={`project-file-item${params.get('file') === f.fileId ? ' project-file-item--selected' : ''}`}>
            <div className="project-file-main"><div className="file-info"><strong>{f.filename}</strong><small>{Math.ceil(f.sizeBytes / 1024)} KB · {f.status === 'ready' ? (f.inclusion === 'never' ? 'Excluded from AI context' : f.inclusion === 'always' ? 'Included excerpt every message' : 'Used when relevant') : f.status}</small>{f.errorMessage && <p role="alert">{f.errorMessage}</p>}
              {(f.status === 'error' || (f.status === 'uploading' && !activeUploads.current.has(`${projectId}/${f.fileId}`))) && !f.fileId.startsWith('local-') && <button className="btn-action" disabled={pending} onClick={() => action(async () => { await api.finalizeProjectFile(projectId, f.fileId); uploadFailures.current.delete(`${projectId}/${f.fileId}`) })}>Retry processing</button>}
            </div>
              <ItemMenu label={`Actions for ${f.filename}`}>
                {f.url && <a href={f.url} target="_blank" rel="noreferrer">Open / download file</a>}
                {f.status === 'ready' && <><button onClick={() => setEdit({ kind: 'file', id: f.fileId, text: f.summary ?? '' })}>Edit description</button><button onClick={() => { bumpNewChatTick(); navigate(`/c/new?project=${projectId}`, { state: { draft: `Please read project file ${f.filename} (fileId: ${f.fileId}) and help me with: ` } }) }}>Ask about this file</button></>}
                <button disabled={pending} onClick={() => {
                  if (!confirm(`Remove ${f.filename} from this project?`)) return
                  if (f.fileId.startsWith('local-')) setFiles(fs => fs.filter(x => x.fileId !== f.fileId))
                  else void action(() => api.deleteProjectFile(projectId, f.fileId))
                }}>Delete file</button>
              </ItemMenu></div>
            {f.status === 'ready' && <details open={params.get('file') === f.fileId}><summary>Details and usage</summary><p>{f.summary}</p><label>Use in chats<select aria-label={`Usage for ${f.filename}`} value={f.inclusion} onChange={e => action(() => api.updateProjectFile(projectId, f.fileId, { inclusion: e.target.value as ProjectFile['inclusion'] }))}><option value="auto">Use when relevant</option><option value="always" disabled={f.contentType.startsWith('image/')}>Include excerpt every message</option><option value="never">Exclude from AI context</option></select></label><small>Included excerpts are limited to 20,000 characters per file and 80,000 total. The assistant can read more when needed. Exclusion does not erase content already in a chat.</small></details>}
          </article>)}
        </section>
        <section className="project-section"><div className="project-section-header">Saved facts<button className="btn-action" onClick={() => setNewFact(true)}>Add fact</button></div><p className="memory-hint">{project?.memoryEnabled === false ? 'Project memory is off. These facts are kept, but not used or updated in chats.' : 'Shared across project chats. Facts you add or edit are protected from automatic rewriting.'}</p>
          {!memories.length && <p className="panel-empty">Add a fact or let the assistant learn as you work.</p>}
          {memories.map(m => <article className="memory-item" key={m.memId}><div className="memory-text"><p>{m.text}</p><small>{m.category}{m.userEdited ? ' · Maintained by you' : ''}</small>{m.sourceChatId && <Link to={`/c/${m.sourceChatId}`}>Source chat</Link>}</div><ItemMenu label="Fact actions"><button onClick={() => setEdit({ kind: 'memory', id: m.memId, text: m.text })}>Edit fact</button><button onClick={() => { if (confirm('Delete this saved fact?')) void action(() => api.deleteProjectMemory(projectId, m.memId)) }}>Delete fact</button></ItemMenu></article>)}
        </section>
      </div>}
    </div>
    <ProjectDetailsDialog open={details} onClose={() => { if (description !== (project?.description ?? '')) trackDesc(save({ description })); if (instructions !== (project?.instructions ?? '')) trackInstr(save({ instructions })); setDetails(false) }} projectName={project?.name ?? 'Project'} descDraft={description} onDescChange={setDescription} onDescBlur={() => { if (description !== project?.description) trackDesc(save({ description })) }} descSaveStatus={descStatus} instrDraft={instructions} onInstrChange={setInstructions} onInstrBlur={() => { if (instructions !== project?.instructions) trackInstr(save({ instructions })) }} instrSaveStatus={instrStatus} models={models} defaultModel={project?.defaultModel ?? ''} onDefaultModelChange={v => { void action(() => save({ defaultModel: v || null })) }} settings={{ ...userPreferences, ...project?.modelSettings }} onSettingsChange={(next: ModelSettings) => { const effective = { ...userPreferences, ...project?.modelSettings }; const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== effective[key as keyof ModelSettings])); void action(() => save({ modelSettings: { ...project?.modelSettings, ...changed } })) }} memoryEnabled={project?.memoryEnabled !== false} onToggleMemory={() => { void action(() => save({ memoryEnabled: project?.memoryEnabled === false })) }} />
    <Dialog open={addChats} onClose={() => setAddChats(false)} title="Add existing chats"><p>Choose a chat to move into this project.</p>{sortByRecent(chats.filter(c => c.projectId !== projectId && !c.sensitive)).map(c => <button key={c.chatId} className="search-result" disabled={pending} onClick={() => action(async () => { await api.moveChatToProject(c.chatId, projectId); updateChatProjectId(c.chatId, projectId); pushToast({ kind: 'success', text: 'Chat added to project' }) })}>{c.title}</button>)}</Dialog>
    <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit?.kind === 'name' ? 'Rename project' : 'Edit description or fact'}><textarea className="pref-textarea" aria-label="Edit text" value={edit?.text ?? ''} onChange={e => setEdit(x => x && { ...x, text: e.target.value })} />{actionError && <p role="alert">{actionError}</p>}<div className="form-actions"><button onClick={() => setEdit(null)}>Cancel</button><button disabled={pending || !edit?.text.trim()} onClick={async () => { if (!edit) return; const ok = await action(() => edit.kind === 'name' ? save({ name: edit.text.trim() }) : edit.kind === 'memory' ? api.updateProjectMemory(projectId, edit.id, { text: edit.text.trim() }) : api.updateProjectFile(projectId, edit.id, { summary: edit.text.trim() })); if (ok) setEdit(null) }}>Save</button></div></Dialog>
    <Dialog open={newFact} onClose={() => setNewFact(false)} title="Add project fact"><textarea className="pref-textarea" aria-label="Fact" placeholder="A decision, convention, or fact to remember…" value={fact} onChange={e => setFact(e.target.value)} />{actionError && <p role="alert">{actionError}</p>}<button className="btn-action" disabled={pending || !fact.trim()} onClick={async () => { if (await action(() => api.createProjectMemory(projectId, fact.trim()))) { setFact(''); setNewFact(false) } }}>Save fact</button></Dialog>
  </div>
}
