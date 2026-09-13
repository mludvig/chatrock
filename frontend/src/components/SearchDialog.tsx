import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type ProjectFile } from '../api/http'
import { useChatStore } from '../store/chatStore'
import Dialog from './Dialog'

// Navigation search never creates a chat. See docs/adr/0045-simple-navigation-and-project-drafts.md.
export default function SearchDialog({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId?: string }) {
  const { chats, projects, setPendingSearch, bumpNewChatTick } = useChatStore()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('')
  const [files, setFiles] = useState<Array<ProjectFile & { projectId: string }>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => { if (open) { setScope(projectId ?? ''); setQuery('') } }, [open, projectId])
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true); setError(''); setFiles([])
    const targets = projects.filter(p => !scope || p.projectId === scope)
    Promise.allSettled(targets.map(async p => ({ projectId: p.projectId, ...(await api.listProjectFiles(p.projectId)) })))
      .then(results => {
        if (cancelled) return
        setFiles(results.flatMap(r => r.status === 'fulfilled' ? r.value.files.map(f => ({ ...f, projectId: r.value.projectId })) : []))
        if (results.some(r => r.status === 'rejected')) setError('Some project files could not be loaded.')
      }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, projects, scope, retry])
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const matches = (...parts: Array<string | undefined>) => terms.every(t => parts.join(' ').toLowerCase().includes(t))
  const results = [
    ...chats.filter(c => !c.sensitive && (!scope || c.projectId === scope) && matches(c.title, c.summary, c.topics?.join(' '))).map(c => ({ id: c.chatId, title: c.title, kind: 'Chat', detail: c.summary, to: `/c/${c.chatId}` })),
    ...files.filter(f => matches(f.filename, f.microLabel, f.summary)).map(f => ({ id: f.fileId, title: f.filename, kind: 'File', detail: f.microLabel, to: `/p/${f.projectId}?file=${f.fileId}` })),
  ]
  return <Dialog open={open} onClose={onClose} title="Search chats and files">
    <input autoFocus className="search-field" aria-label="Search chats and files" placeholder="Search titles, topics, summaries and filenames…" value={query} onChange={e => setQuery(e.target.value)} />
    <select className="pref-select" aria-label="Search scope" value={scope} onChange={e => setScope(e.target.value)}><option value="">Everywhere</option>{projects.map(p => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}</select>
    {error && <div role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>Retry</button></div>}
    {loading && <p role="status">Loading project files…</p>}
    <div className="search-results">{results.slice(0, 100).map(r => <button key={r.id} className="search-result" onClick={() => { onClose(); navigate(r.to) }}><small>{r.kind}</small><strong>{r.title}</strong>{r.detail && <span>{r.detail}</span>}</button>)}</div>
    {!results.length && !loading && <p className="panel-empty">No matches. Try another word or search everywhere.</p>}
    {results.length > 100 && <p>Showing the first 100 matches. Narrow your search to see more.</p>}
    {query.trim() && <button className="btn-action" onClick={() => {
      setPendingSearch({ query, scope: scope ? 'project' : 'global', ...(scope ? { projectId: scope } : {}) })
      bumpNewChatTick(); onClose(); navigate('/c/new')
    }}>Ask AI to search by meaning</button>}
  </Dialog>
}
