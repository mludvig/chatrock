import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faEye, faEyeSlash } from '@fortawesome/free-solid-svg-icons'

export function filterPrivateChats<T extends { sensitive?: boolean }>(chats: T[], visible: boolean): T[] {
  return chats.filter(chat => visible || !chat.sensitive)
}

export default function PrivateChatToggle({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return <button
    className="private-chat-toggle"
    type="button"
    aria-label="Show private chats"
    aria-pressed={visible}
    title={visible ? 'Hide private chats' : 'Show private chats'}
    onClick={onToggle}
  ><FontAwesomeIcon icon={visible ? faEye : faEyeSlash} /></button>
}
