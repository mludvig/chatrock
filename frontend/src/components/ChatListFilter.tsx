import { useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faFilter } from '@fortawesome/free-solid-svg-icons'

// Client-only view preference — deliberately not persisted (matches the pre-existing
// "Non-project only" toggle it's now bundled with). Defaults to hidden: a sensitive chat
// should never appear on screen just because the sidebar re-rendered.
export function useChatListFilter() {
  const [showSensitive, setShowSensitive] = useState(false)
  const [showProjectChats, setShowProjectChats] = useState(false)
  return { showSensitive, setShowSensitive, showProjectChats, setShowProjectChats }
}

export type ChatListFilterState = ReturnType<typeof useChatListFilter>

// Filters a chat list by both toggles. Shared so ChatsPanel and ProjectView apply the exact
// same sensitive-chat visibility rule instead of each re-deriving it.
export function applyChatListFilter<T extends { sensitive?: boolean; projectId?: string }>(
  chats: T[],
  filter: Pick<ChatListFilterState, 'showSensitive' | 'showProjectChats'>,
  opts?: { includeProjectChats?: boolean },
): T[] {
  const includeProject = opts?.includeProjectChats ?? filter.showProjectChats
  return chats.filter(c => (includeProject || !c.projectId) && (filter.showSensitive || !c.sensitive))
}

// Single funnel button + popover. `showProjectToggle` is omitted in contexts already scoped
// to one project (ProjectView), where an "include project chats" toggle makes no sense.
export default function ChatListFilter({ filter, showProjectToggle = true }: { filter: ChatListFilterState; showProjectToggle?: boolean }) {
  const [open, setOpen] = useState(false)
  const active = filter.showSensitive || filter.showProjectChats

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open])

  return (
    <div className="chat-list-filter" style={{ position: 'relative' }}>
      <button
        type="button"
        className={`chat-filter-btn${active ? ' active' : ''}`}
        onClick={() => setOpen(v => !v)}
        title="Chat list filters"
      >
        <FontAwesomeIcon icon={faFilter} /> Filter
      </button>
      {open && (
        <div className="chat-list-filter-menu" onClick={e => e.stopPropagation()}>
          {showProjectToggle && (
            <label className="chat-list-filter-item">
              <input
                type="checkbox"
                checked={filter.showProjectChats}
                onChange={e => filter.setShowProjectChats(e.target.checked)}
              />
              Show project chats
            </label>
          )}
          <label className="chat-list-filter-item">
            <input
              type="checkbox"
              checked={filter.showSensitive}
              onChange={e => filter.setShowSensitive(e.target.checked)}
            />
            Show sensitive chats
          </label>
        </div>
      )}
    </div>
  )
}
