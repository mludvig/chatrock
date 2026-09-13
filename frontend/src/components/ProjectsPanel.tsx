import { useEffect, useState } from 'react'
import { Link, useMatch, useNavigate } from 'react-router-dom'
import { api } from '../api/http'
import { useChatStore } from '../store/chatStore'
import ItemMenu from './ItemMenu'

export default function ProjectsPanel() {
  const navigate = useNavigate()
  const active = useMatch('/p/:projectId')?.params.projectId
  const { projects, chats, setProjects, addProject, removeProject, updateChatProjectId, pushToast, newProjectTick, bumpNewChatTick } = useChatStore()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  useEffect(() => {
    let cancelled = false
    api.listProjects().then(r => { if (!cancelled) setProjects(r.projects) }).catch(() => {})
    return () => { cancelled = true }
  }, [setProjects])
  useEffect(() => { if (newProjectTick) setCreating(true) }, [newProjectTick])

  async function create(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || pending) return
    setPending(true)
    try {
      const { projectId } = await api.createProject(name.trim())
      const now = new Date().toISOString()
      addProject({ projectId, name: name.trim(), createdAt: now, updatedAt: now })
      setCreating(false); setName(''); navigate(`/p/${projectId}`)
    } catch (err) { pushToast({ kind: 'error', text: String(err) }) }
    finally { setPending(false) }
  }
  async function remove(projectId: string) {
    if (!confirm('Delete this project and its files and saved facts? Its chats will be kept outside the project.')) return
    try {
      await api.deleteProject(projectId)
      chats.filter(c => c.projectId === projectId).forEach(c => updateChatProjectId(c.chatId, null))
      removeProject(projectId)
      if (active === projectId) navigate('/c/new')
    } catch (err) { pushToast({ kind: 'error', text: String(err) }) }
  }
  const recent = [...projects].sort((a, b) => {
    const activity = (id: string, date: string) => Math.max(Date.parse(date), ...chats.filter(c => c.projectId === id).map(c => Date.parse(c.updatedAt)))
    return activity(b.projectId, b.updatedAt) - activity(a.projectId, a.updatedAt)
  })
  return <section className="projects-panel" aria-label="Projects">
    <div className="panel-header"><span>Projects</span><button className="panel-header-btn" title="New project" onClick={() => setCreating(true)}>+</button></div>
    {creating && <form className="new-project-bar" onSubmit={create}>
      <input autoFocus aria-label="Project name" placeholder="Project name…" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setCreating(false) }} />
      <div className="form-actions"><button type="button" onClick={() => setCreating(false)}>Cancel</button><button disabled={pending || !name.trim()}>{pending ? 'Creating…' : 'Create'}</button></div>
    </form>}
    <div className="project-list">{recent.map(p => <div className={`project-item navigation-row${active === p.projectId ? ' active' : ''}`} key={p.projectId}>
      <Link className="project-title" to={`/p/${p.projectId}`} aria-current={active === p.projectId ? 'page' : undefined}>{p.name}</Link>
      <ItemMenu label={`Actions for ${p.name}`}>
        <button onClick={() => { bumpNewChatTick(); navigate(`/c/new?project=${p.projectId}`, { state: { draft: '' } }) }}>New chat in this project</button>
        <button onClick={() => navigate(`/p/${p.projectId}?settings=1`)}>Project settings</button>
        <button onClick={() => remove(p.projectId)}>Delete project</button>
      </ItemMenu>
    </div>)}</div>
    {!projects.length && !creating && <p className="empty-hint">Group chats and share knowledge in a project.</p>}
  </section>
}
