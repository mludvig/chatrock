import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from 'react-oidc-context'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faComments } from '@fortawesome/free-solid-svg-icons'
import { api, setAccessToken } from './api/http'
import { useChatStore } from './store/chatStore'
import Sidebar from './components/Sidebar'
import ChatView from './components/ChatView'
import Toaster from './components/Toaster'
import './app.scss'

function AuthedApp() {
  const navigate = useNavigate()
  const location = useLocation()
  const { setChats, setModels, models, setLoading, renameChat, lastModel, setLastModel, sidebarWidth, setSidebarWidth } = useChatStore()
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
    Promise.all([api.listChats(), api.listModels()])
      .then(([chatsRes, modelsRes]) => {
        const sorted = chatsRes.chats.sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        )
        setChats(sorted)
        setModels(modelsRes.models)
      })
      .finally(() => setLoading(false))
  }, [auth.isAuthenticated, accessToken, setChats, setModels, setLoading])

  // Auto-close sidebar on navigation (mobile)
  useEffect(() => { setSidebarOpen(false) }, [location.pathname])

  const defaultModel = lastModel || models[1]?.id || models[0]?.id || ''

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(180, Math.min(480, ev.clientX))
      setSidebarWidth(w)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      className={`layout${sidebarOpen ? ' sidebar-open' : ''}`}
      style={{ ['--sidebar-w' as string]: `${sidebarWidth}px` }}
    >
      {sidebarOpen && (
        <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      )}
      <Sidebar
        userName={userName}
        onNewChat={() => navigate('/c/new')}
        onSignOut={() => auth.signoutRedirect()}
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

  if (auth.isLoading) {
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
