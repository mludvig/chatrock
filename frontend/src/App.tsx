import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from 'react-oidc-context'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faComments, faPlus } from '@fortawesome/free-solid-svg-icons'
import { api, setAccessToken } from './api/http'
import { useChatStore } from './store/chatStore'
import ActivityBar from './components/ActivityBar'
import Sidebar from './components/Sidebar'
import ChatView from './components/ChatView'
import Toaster from './components/Toaster'
import './app.scss'

function AuthedApp() {
  const navigate = useNavigate()
  const location = useLocation()
  const { setChats, setModels, models, setLoading, renameChat, lastModel, setLastModel, sidebarWidth, setSidebarWidth, setUserPreferences, userPreferences } = useChatStore()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const auth = useAuth()
  const accessToken = auth.user?.access_token ?? ''
  const userName = auth.user?.profile.email ?? auth.user?.profile.sub ?? 'User'

  // Set synchronously during render so child effects (e.g. ChatView's listMessages)
  // see the token immediately on first mount.  A useEffect would run after children's
  // effects — too late on the first render after a page reload.
  setAccessToken(accessToken)

  useEffect(() => {
    if (!auth.isAuthenticated || !accessToken) return
    setLoading(true)
    Promise.all([api.listChats(), api.listModels(), api.getPreferences()])
      .then(([chatsRes, modelsRes, prefsRes]) => {
        const sorted = chatsRes.chats.sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        )
        setChats(sorted)
        setModels(modelsRes.models)
        setUserPreferences(prefsRes.preferences)
      })
      .finally(() => setLoading(false))
  }, [auth.isAuthenticated, accessToken, setChats, setModels, setLoading, setUserPreferences])

  // Auto-close sidebar on navigation (mobile)
  useEffect(() => { setSidebarOpen(false) }, [location.pathname])

  const defaultModel = lastModel || userPreferences.defaultModel || models[1]?.id || models[0]?.id || ''

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    document.body.style.userSelect = 'none'
    const onMove = (ev: PointerEvent) => {
      // Subtract the 48px activity bar from the pointer position
      const w = Math.max(180, Math.min(480, ev.clientX - 48))
      setSidebarWidth(w)
    }
    const onUp = () => {
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return (
    <div
      className={`layout${sidebarOpen ? ' sidebar-open' : ''}`}
      style={{ ['--sidebar-w' as string]: `${sidebarWidth}px` }}
    >
      {sidebarOpen && (
        <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      )}
      <div className="sidebar-global-header" onClick={() => navigate('/c/new')} title="New chat">
        <span className="sidebar-brand">
          <FontAwesomeIcon icon={faComments} className="sidebar-brand-icon" />
          Chatrock
        </span>
        <button
          className="btn-new"
          onClick={e => { e.stopPropagation(); navigate('/c/new') }}
          title="New chat"
          tabIndex={-1}
        >
          <FontAwesomeIcon icon={faPlus} />
        </button>
      </div>
      <ActivityBar
        userName={userName}
        onSignOut={() => auth.signoutRedirect()}
      />
      <Sidebar
        onRenameChat={renameChat}
      />
      <div className="sidebar-resizer" onPointerDown={startResize} title="Drag to resize sidebar" />
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/c/new" replace />} />
          <Route
            path="/c/:chatId"
            element={
              <ChatView
                accessToken={accessToken}
                models={models}
                defaultModel={defaultModel}
                onModelChange={setLastModel}
                onOpenSidebar={() => setSidebarOpen(true)}
              />
            }
          />
          <Route path="*" element={<Navigate to="/c/new" replace />} />
        </Routes>
      </main>
    </div>
  )
}

export default function App() {
  const auth = useAuth()

  // If the access token expired but we have a refresh token, renew silently before
  // falling through to the login screen. This covers the common case of returning to
  // the app after >1 hour — the refresh token is still valid (30-day window) so the
  // user should never see the login prompt.
  useEffect(() => {
    if (!auth.isLoading && !auth.isAuthenticated && !auth.activeNavigator && !auth.error) {
      if (auth.user?.refresh_token) {
        void auth.signinSilent()
      }
    }
  }, [auth])

  if (auth.isLoading || (!auth.isAuthenticated && auth.user?.refresh_token && !auth.error)) {
    return <div className="splash">Loading…</div>
  }

  if (auth.error) {
    return (
      <div className="splash error">
        Auth error: {auth.error.message}
        <button onClick={() => auth.removeUser()}>Reset</button>
      </div>
    )
  }

  if (!auth.isAuthenticated) {
    return (
      <div className="splash">
        <div className="login-card">
          <div className="login-logo">
            <FontAwesomeIcon icon={faComments} />
          </div>
          <h1>Chatrock</h1>
          <p>Sign in to start chatting.</p>
          <button className="btn-primary btn-lg" onClick={() => auth.signinRedirect()}>
            Sign in
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <AuthedApp />
      <Toaster />
    </>
  )
}
