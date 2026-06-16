import { useChatStore } from '../store/chatStore'
import ChatsPanel from './ChatsPanel'
import MemoryPanel from './MemoryPanel'
import PreferencesPanel from './PreferencesPanel'
import ProjectsPanel from './ProjectsPanel'

export default function Sidebar() {
  const { activePanel } = useChatStore()

  return (
    <aside className="sidebar">
      {activePanel === 'chats' && (
        <ChatsPanel />
      )}
      {activePanel === 'memory' && (
        <MemoryPanel />
      )}
      {activePanel === 'prefs' && (
        <PreferencesPanel />
      )}
      {activePanel === 'projects' && (
        <ProjectsPanel />
      )}
    </aside>
  )
}
