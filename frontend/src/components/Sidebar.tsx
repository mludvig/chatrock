import { useChatStore } from '../store/chatStore'
import ChatsPanel from './ChatsPanel'
import MemoryPanel from './MemoryPanel'
import PreferencesPanel from './PreferencesPanel'
import ProjectsPanel from './ProjectsPanel'

export default function Sidebar({ onSignOut }: { onSignOut: () => void }) {
  const { activePanel, setActivePanel } = useChatStore()
  const settings = activePanel === 'prefs' || activePanel === 'memory'
  return <aside className="sidebar" aria-label="Navigation">
    {settings ? <>
      <button className="nav-back" onClick={() => setActivePanel('chats')}>← Back to chats and projects</button>
      <div className="settings-nav"><button data-panel="prefs" onClick={() => setActivePanel('prefs')}>Preferences</button><button data-panel="memory" onClick={() => setActivePanel('memory')}>Personal memory</button></div>
      <div className="sidebar-scroll">{activePanel === 'prefs' ? <PreferencesPanel /> : <MemoryPanel />}</div>
    </> : <div className="sidebar-scroll"><ProjectsPanel /><div className="panel-header">Recent chats</div><ChatsPanel /></div>}
    <div className="sidebar-footer"><button data-panel="prefs" onClick={() => setActivePanel('prefs')}>Settings</button><button onClick={onSignOut}>Sign out</button></div>
  </aside>
}
