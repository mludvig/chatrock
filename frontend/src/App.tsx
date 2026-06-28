import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from 'react-oidc-context'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faComments, faPlus, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons'
import { api, setAccessToken } from './api/http'
import { ENV } from './env'
import { useChatStore } from './store/chatStore'
import ActivityBar from './components/ActivityBar'
import Sidebar from './components/Sidebar'
import ChatView from './components/ChatView'
import ProjectView from './components/ProjectView'
import Toaster from './components/Toaster'
import './app.scss'

function AuthedApp() {
  const navigate = useNavigate()
  const location = useLocation()
  const { chats, setChats, setModels, models, setLoading, lastModel, setLastModel, sidebarWidth, setSidebarWidth, setUserPreferences, userPreferences, setProjects, setPendingSearch } = useChatStore()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // Default on: searching from inside a project most often means "this project", not everywhere.
  const [searchProjectOnly, setSearchProjectOnly] = useState(true)

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
    Promise.all([api.listChats(), api.listModels(), api.getPreferences(), api.listProjects()])
      .then(([chatsRes, modelsRes, prefsRes, projectsRes]) => {
        const sorted = chatsRes.chats.sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        )
        setChats(sorted)
        setModels(modelsRes.models)
        setUserPreferences(prefsRes.preferences)
        setProjects(projectsRes.projects)
      })
      .finally(() => setLoading(false))
  }, [auth.isAuthenticated, accessToken, setChats, setModels, setLoading, setUserPreferences, setProjects])

  // Auto-close sidebar on navigation (mobile)
  useEffect(() => { setSidebarOpen(false) }, [location.pathname])

  const defaultModel = lastModel || userPreferences.defaultModel || models[1]?.id || models[0]?.id || ''

  // Search's "Project only" toggle only makes sense when the current view is project-scoped:
  // either the project dashboard itself, or a chat that belongs to a project.
  const projectViewMatch = /^\/p\/([^/]+)/.exec(location.pathname)
  const chatViewMatch = /^\/c\/([^/]+)/.exec(location.pathname)
  const currentChatProjectId = chatViewMatch ? chats.find(c => c.chatId === chatViewMatch[1])?.projectId : undefined
  const contextProjectId = projectViewMatch?.[1] ?? currentChatProjectId

  function submitSearch() {
    const query = searchQuery.trim()
    if (!query) return
    const scope: 'project' | 'global' = (contextProjectId && searchProjectOnly) ? 'project' : 'global'
    setPendingSearch({ query, scope, ...(scope === 'project' ? { projectId: contextProjectId } : {}) })
    setSearchQuery('')
    navigate('/c/new')
  }

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
          <span className="sidebar-brand-text">Chatrock</span>
        </span>
        <div className="search-box" onClick={e => e.stopPropagation()}>
          <FontAwesomeIcon icon={faMagnifyingGlass} className="search-icon" />
          <input
            type="text"
            className="search-input"
            placeholder="Search past chats & files…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitSearch() }}
          />
          {contextProjectId && (
            <button
              type="button"
              className={`search-scope-toggle${searchProjectOnly ? ' active' : ''}`}
              onClick={() => setSearchProjectOnly(v => !v)}
              title={searchProjectOnly ? 'Searching this project only — click to search everywhere' : 'Searching everywhere — click to limit to project'}
            >
              Project
            </button>
          )}
        </div>
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
        onSignOut={() => auth.signoutRedirect({ extraQueryParams: { client_id: ENV.cognitoClientId, logout_uri: `${ENV.appUrl}/` } })}
      />
      <Sidebar />
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
          <Route path="/p/:projectId" element={<ProjectView defaultModel={defaultModel} />} />
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

  // Auto-retry on transient network errors (e.g. laptop wake / coming back online).
  // The refresh token is still valid — we just couldn't reach the token endpoint.
  const isNetworkError = /NetworkError|Failed to fetch|network/i.test(auth.error?.message ?? '')
  useEffect(() => {
    if (!isNetworkError) return
    const timer = setTimeout(() => void auth.signinSilent(), 3000)
    return () => clearTimeout(timer)
  }, [isNetworkError, auth])

  if (auth.isLoading || (!auth.isAuthenticated && auth.user?.refresh_token && !auth.error)) {
    return <div className="splash">Loading…</div>
  }

  if (auth.error) {
    return (
      <div className="splash error">
        {isNetworkError ? 'Connection error — retrying…' : `Auth error: ${auth.error.message}`}
        <button onClick={() => void auth.removeUser().then(() => auth.signinRedirect())}>Reset</button>
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
