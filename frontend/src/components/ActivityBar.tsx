import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faListUl, faBrain, faSlidersH, faRightFromBracket, faFolderTree } from '@fortawesome/free-solid-svg-icons'
import type { ActivePanel } from '../store/chatStore'
import { useChatStore } from '../store/chatStore'

interface Props {
  userName: string
  onSignOut: () => void
}

export default function ActivityBar({ userName, onSignOut }: Props) {
  const { activePanel, setActivePanel } = useChatStore()

  return (
    <div className="activity-bar">
      <div className="activity-bar-top">
        <button
          className={`activity-btn${activePanel === 'chats' ? ' active' : ''}`}
          onClick={() => setActivePanel('chats' as ActivePanel)}
          title="Chats"
          data-panel="chats"
        >
          <FontAwesomeIcon icon={faListUl} />
        </button>
        <button
          className={`activity-btn${activePanel === 'projects' ? ' active' : ''}`}
          onClick={() => setActivePanel('projects' as ActivePanel)}
          title="Projects"
          data-panel="projects"
        >
          <FontAwesomeIcon icon={faFolderTree} />
        </button>
        <button
          className={`activity-btn${activePanel === 'memory' ? ' active' : ''}`}
          onClick={() => setActivePanel('memory' as ActivePanel)}
          title="Memory"
          data-panel="memory"
        >
          <FontAwesomeIcon icon={faBrain} />
        </button>
        <button
          className={`activity-btn${activePanel === 'prefs' ? ' active' : ''}`}
          onClick={() => setActivePanel('prefs' as ActivePanel)}
          title="Preferences"
          data-panel="prefs"
        >
          <FontAwesomeIcon icon={faSlidersH} />
        </button>
      </div>

      <div className="activity-bar-bottom">
        <button
          className="activity-btn activity-btn--signout"
          onClick={onSignOut}
          title={`Sign out (${userName})`}
        >
          <FontAwesomeIcon icon={faRightFromBracket} />
        </button>
      </div>
    </div>
  )
}
