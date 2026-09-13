import { useRef } from 'react'
import { useChatStore } from '../store/chatStore'
import ChatsPanel from './ChatsPanel'
import MemoryPanel from './MemoryPanel'
import PreferencesPanel from './PreferencesPanel'
import ProjectsPanel from './ProjectsPanel'

export default function Sidebar({ onSignOut }: { onSignOut: () => void }) {
  const { activePanel, setActivePanel, sidebarSplit, setSidebarSplit } = useChatStore()
  const navigationRef = useRef<HTMLDivElement>(null)
  const resizingRef = useRef(false)
  const settings = activePanel === 'prefs' || activePanel === 'memory'

  // Keep the split proportional so the saved layout adapts to viewport height changes.
  // See docs/adr/0047-resizable-navigation-split.md.
  function resizeNavigation(clientY: number) {
    const bounds = navigationRef.current?.getBoundingClientRect()
    if (!bounds || bounds.height <= 0) return
    setSidebarSplit(Math.max(0.2, Math.min(0.8, (clientY - bounds.top) / bounds.height)))
  }

  function finishResize() {
    if (!resizingRef.current) return
    resizingRef.current = false
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }

  function handleDividerKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    let next = sidebarSplit
    if (e.key === 'ArrowUp') next -= 0.05
    else if (e.key === 'ArrowDown') next += 0.05
    else if (e.key === 'Home') next = 0.2
    else if (e.key === 'End') next = 0.8
    else return
    e.preventDefault()
    setSidebarSplit(Math.max(0.2, Math.min(0.8, next)))
  }

  return <aside className="sidebar" aria-label="Navigation">
    {settings ? <>
      <button className="nav-back" onClick={() => setActivePanel('chats')}>← Back to chats and projects</button>
      <div className="settings-nav"><button data-panel="prefs" onClick={() => setActivePanel('prefs')}>Preferences</button><button data-panel="memory" onClick={() => setActivePanel('memory')}>Personal memory</button></div>
      <div className="sidebar-scroll">{activePanel === 'prefs' ? <PreferencesPanel /> : <MemoryPanel />}</div>
    </> : <div
      ref={navigationRef}
      className="sidebar-scroll sidebar-navigation"
      style={{ ['--sidebar-split' as string]: `${sidebarSplit * 100}%` }}
    >
      <ChatsPanel />
      <div
        className="sidebar-divider"
        role="separator"
        aria-label="Resize recent chats and projects"
        aria-orientation="horizontal"
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={Math.round(sidebarSplit * 100)}
        tabIndex={0}
        title="Drag to resize recent chats and projects"
        onPointerDown={e => {
          e.preventDefault()
          resizingRef.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          document.body.style.userSelect = 'none'
          document.body.style.cursor = 'row-resize'
          resizeNavigation(e.clientY)
        }}
        onPointerMove={e => {
          if (resizingRef.current) resizeNavigation(e.clientY)
        }}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
        onKeyDown={handleDividerKeyDown}
      />
      <ProjectsPanel />
    </div>}
    <div className="sidebar-footer">
      {settings
        ? <button className="btn-signout" onClick={onSignOut}>Sign out</button>
        : <button data-panel="prefs" onClick={() => setActivePanel('prefs')}>Settings</button>}
    </div>
  </aside>
}
