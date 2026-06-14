import { useChatStore } from '../store/chatStore'
import ChatsPanel from './ChatsPanel'
import MemoryPanel from './MemoryPanel'
import PreferencesPanel from './PreferencesPanel'

interface Props {
  onNewChat: () => void
  onRenameChat: (chatId: string, title: string) => void
}

export default function Sidebar({ onNewChat, onRenameChat }: Props) {
  const { activePanel } = useChatStore()

  return (
    <aside className="sidebar">
      {activePanel === 'chats' && (
        <ChatsPanel onNewChat={onNewChat} onRenameChat={onRenameChat} />
      )}
      {activePanel === 'memory' && (
        <MemoryPanel />
      )}
      {activePanel === 'prefs' && (
        <PreferencesPanel />
      )}
    </aside>
  )
}
