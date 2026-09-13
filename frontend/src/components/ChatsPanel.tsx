import { useState } from 'react'
import { Link, useMatch, useNavigate } from 'react-router-dom'
import { api } from '../api/http'
import { useChatStore } from '../store/chatStore'
import { sortByRecent } from '../lib/sort'
import PrivateChatToggle, { filterPrivateChats } from './PrivateChatToggle'
import ItemMenu from './ItemMenu'
import Dialog from './Dialog'

export default function ChatsPanel() {
  const active = useMatch('/c/:chatId')?.params.chatId
  const navigate = useNavigate()
  const { chats, projects, loading, patchChat, removeChat, updateChatProjectId, sendingByChat, pushToast } = useChatStore()
  const [showPrivate, setShowPrivate] = useState(false)
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function run(fn: () => Promise<void>) {
    setPending(true); setError('')
    try { await fn() } catch (e) { setError(String(e)); pushToast({ kind: 'error', text: String(e) }) }
    finally { setPending(false) }
  }
  const visibleChats = sortByRecent(filterPrivateChats(chats, showPrivate))
  return <section className="chats-panel" aria-label="Recent chats">
    <div className="panel-header"><span>Recent chats</span><PrivateChatToggle visible={showPrivate} onToggle={() => setShowPrivate(v => !v)} /></div>
    <div className="chat-list">
      {loading && !chats.length && <p className="panel-loading" role="status">Loading chats…</p>}
      {!loading && !visibleChats.length && <p className="empty-hint">{chats.length ? 'Private chats are hidden.' : 'Start a chat to begin.'}</p>}
      {visibleChats.map(c => <div key={c.chatId} className={`chat-item unified-chat-row navigation-row${c.chatId === active ? ' active' : ''}${c.sensitive ? ' sensitive' : ''}`}>
      <Link to={`/c/${c.chatId}`} className="chat-item-content" aria-current={c.chatId === active ? 'page' : undefined}><span className="chat-title">{sendingByChat[c.chatId] ? '◌ ' : ''}{c.title}</span>{c.projectId && <small>{projects.find(p => p.projectId === c.projectId)?.name ?? 'Project'}</small>}</Link>
      <ItemMenu label={`Actions for ${c.title}`}>
        <button onClick={() => setEditing({ id: c.chatId, title: c.title })}>Rename chat</button>
        <button onClick={() => setMoving(c.chatId)}>Move to project</button>
        <button disabled={pending} onClick={() => run(async () => { const r = await api.retitleChat(c.chatId); patchChat(c.chatId, { title: r.title }) })}>Suggest title</button>
        <button disabled={pending} onClick={() => { if (confirm('Delete this chat and its messages? This cannot be undone.')) void run(async () => { await api.deleteChat(c.chatId); removeChat(c.chatId); if (active === c.chatId) navigate('/c/new') }) }}>Delete chat</button>
      </ItemMenu>
    </div>)}</div>
    <Dialog open={!!editing} onClose={() => setEditing(null)} title="Rename chat"><input autoFocus className="search-field" aria-label="Chat title" value={editing?.title ?? ''} onChange={e => setEditing(x => x && { ...x, title: e.target.value })} />{error && <p role="alert">{error}</p>}<div className="form-actions"><button onClick={() => setEditing(null)}>Cancel</button><button disabled={pending || !editing?.title.trim()} onClick={() => run(async () => { if (!editing) return; await api.renameChat(editing.id, editing.title.trim()); patchChat(editing.id, { title: editing.title.trim() }); setEditing(null) })}>Save</button></div></Dialog>
    <Dialog open={!!moving} onClose={() => setMoving(null)} title="Move chat to project">{error && <p role="alert">{error}</p>}{[{ projectId: '', name: 'No project' }, ...projects].map(p => <button className="search-result" key={p.projectId} disabled={pending} onClick={() => run(async () => { if (!moving) return; await api.moveChatToProject(moving, p.projectId || null); updateChatProjectId(moving, p.projectId || null); setMoving(null) })}>{p.name}</button>)}</Dialog>
  </section>
}
