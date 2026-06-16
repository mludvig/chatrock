import { useChatStore } from '../store/chatStore'
import ChatsPanel from './ChatsPanel'
import MemoryPanel from './MemoryPanel'
import PreferencesPanel from './PreferencesPanel'
import ProjectsPanel from './ProjectsPanel'

interface Props {
  onRenameChat: (chatId: string, title: string) => void
}

export default function Sidebar({ onRenameChat }: Props) {
  const { activePanel } = useChatStore()

  return (
    <aside className="sidebar">
      {activePanel === 'chats' && (
        <ChatsPanel onRenameChat={onRenameChat} />
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
