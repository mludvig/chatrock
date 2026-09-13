import { useEffect, useRef, useState } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from 'react-oidc-context'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faComments, faPlus, faFolderPlus, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons'
import { api, setAccessToken } from './api/http'
import { setTokenProvider } from './api/ws'
import { ENV } from './env'
import { useChatStore } from './store/chatStore'
import SearchDialog from './components/SearchDialog'
import Sidebar from './components/Sidebar'
import ChatView from './components/ChatView'
import ProjectView from './components/ProjectView'
import Toaster from './components/Toaster'
import './app.scss'

// Renew this far ahead of expiry rather than at it: a token that dies mid-handshake looks
// exactly like a network failure, and the retry would carry the same dead token.
const TOKEN_RENEW_SLACK_S = 120

function AuthedApp() {
  const navigate = useNavigate()
  const location = useLocation()
  const { chats, setChats, setModels, models, setLoading, lastModel, setLastModel, sidebarWidth, setSidebarWidth, setUserPreferences, userPreferences, setProjects, setActivePanel, bumpNewChatTick, bumpNewProjectTick } = useChatStore()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)

  const auth = useAuth()
  const accessToken = auth.user?.access_token ?? ''

  // Set synchronously during render so child effects (e.g. ChatView's listMessages)
  // see the token immediately on first mount.  A useEffect would run after children's
  // effects — too late on the first render after a page reload.
  setAccessToken(accessToken)

  // oidc-client-ts only renews on its `accessTokenExpiring` event, which fires 60 s before
  // expiry — a phone asleep through that window wakes up holding a dead token and nothing
  // ever re-triggers a renew. So both the WebSocket's token provider and the resume handler
  // below renew on demand instead. See docs/adr/0036-websocket-reads-the-token-late.md.
  const authRef = useRef(auth)
  useEffect(() => { authRef.current = auth })

  // `focus` and `visibilitychange` both fire on a resume, and a reconnect can land on top of
  // them — one shared in-flight renewal keeps that from becoming three token requests.
  const renewalRef = useRef<Promise<string> | null>(null)

  const freshAccessToken = async () => {
    const user = authRef.current.user
    if (user && !user.expired && (user.expires_in ?? 0) > TOKEN_RENEW_SLACK_S) return user.access_token
    if (!renewalRef.current) {
      renewalRef.current = authRef.current.signinSilent()
        .then(renewed => {
          // Hand the renewed token to the REST client too — its copy is otherwise only
          // refreshed on the next render, too late for a request already in flight.
          if (renewed?.access_token) setAccessToken(renewed.access_token)
          return renewed?.access_token ?? user?.access_token ?? ''
        })
        .finally(() => { renewalRef.current = null })
    }
    return renewalRef.current
  }

  useEffect(() => { setTokenProvider(freshAccessToken) })

  useEffect(() => {
    function renewIfStale() {
      if (document.visibilityState === 'hidden') return
      void freshAccessToken().catch(() => {})
    }
    document.addEventListener('visibilitychange', renewIfStale)
    window.addEventListener('focus', renewIfStale)
    return () => {
      document.removeEventListener('visibilitychange', renewIfStale)
      window.removeEventListener('focus', renewIfStale)
    }
  }, [])

  useEffect(() => {
    if (!auth.isAuthenticated || !accessToken) return
    let cancelled = false
    setLoading(true)
    setLoadError('')
    Promise.allSettled([api.listChats(), api.getPreferences(), api.listProjects()])
      .then(([chatsRes, prefsRes, projectsRes]) => {
        if (cancelled) return
        if (chatsRes.status === 'fulfilled') setChats(chatsRes.value.chats.sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()))
        if (prefsRes.status === 'fulfilled') setUserPreferences(prefsRes.value.preferences)
        if (projectsRes.status === 'fulfilled') setProjects(projectsRes.value.projects)
        const failed = [chatsRes, prefsRes, projectsRes].flatMap((result, index) =>
          result.status === 'rejected' ? [['chats', 'preferences', 'projects'][index]] : [])
        if (failed.length) setLoadError(`Could not refresh ${failed.join(', ')}. Your previously loaded data is still available.`)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    // Models are cached in localStorage (see chatStore's partialize) and revalidated here,
    // outside the loading gate — the pickers render from the cached list immediately rather
    // than sitting empty until this round-trip lands.
    api.listModels().then(res => { if (!cancelled) setModels(res.models) }).catch(() => { /* keep the cached list */ })
    return () => { cancelled = true }
  }, [auth.isAuthenticated, accessToken, loadAttempt, setChats, setModels, setLoading, setUserPreferences, setProjects])

  // Auto-close sidebar on navigation (mobile)
  useEffect(() => { setSidebarOpen(false) }, [location.pathname])

  const defaultModel = userPreferences.defaultModel || lastModel || models[1]?.id || models[0]?.id || ''

  // Search's "Project only" toggle only makes sense when the current view is project-scoped:
  // either the project dashboard itself, or a chat that belongs to a project. Also reused by
  // the "+" buttons below to file a new chat into the same project — see
  // docs/adr/0045-simple-navigation-and-project-drafts.md.
  const projectViewMatch = /^\/p\/([^/]+)/.exec(location.pathname)
  const chatViewMatch = /^\/c\/([^/]+)/.exec(location.pathname)
  const currentChatProjectId = chatViewMatch ? chats.find(c => c.chatId === chatViewMatch[1])?.projectId : undefined
  const draftProjectId = chatViewMatch?.[1] === 'new' ? new URLSearchParams(location.search).get('project') ?? undefined : undefined
  const contextProjectId = projectViewMatch?.[1] ?? currentChatProjectId ?? draftProjectId

  function startNewChat() {
    setActivePanel('chats')
    bumpNewChatTick()
    navigate(contextProjectId ? `/c/new?project=${contextProjectId}` : '/c/new', { state: { draft: '' } })
  }

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    document.body.style.userSelect = 'none'
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(250, Math.min(480, ev.clientX))
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
      style={{ ['--sidebar-w' as string]: `${Math.max(250, sidebarWidth)}px` }}
    >
      {sidebarOpen && (
        <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      )}
      <div className="sidebar-global-header">
        <button className="sidebar-brand" onClick={startNewChat}><FontAwesomeIcon icon={faComments} /> Chatrock</button>
        <button className="btn-new" onClick={startNewChat} title="New chat"><FontAwesomeIcon icon={faPlus} /></button>
        <button className="btn-new" onClick={() => setSearchOpen(true)} title="Search chats and files"><FontAwesomeIcon icon={faMagnifyingGlass} /></button>
        <button className="btn-new" onClick={() => { setActivePanel('projects'); setSidebarOpen(true); bumpNewProjectTick() }} title="New project"><FontAwesomeIcon icon={faFolderPlus} /></button>
      </div>
      <Sidebar onSignOut={() => auth.signoutRedirect({ extraQueryParams: { client_id: ENV.cognitoClientId, logout_uri: `${ENV.appUrl}/` } })} />
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} projectId={contextProjectId} />
      <div className="sidebar-resizer" onPointerDown={startResize} title="Drag to resize sidebar" />
      <main className="main">
        {loadError && <div className="error-banner" role="alert">{loadError}<button onClick={() => setLoadAttempt(v => v + 1)}>Retry</button></div>}
        <Routes>
          <Route path="/" element={<Navigate to="/c/new" replace />} />
          <Route
            path="/c/:chatId"
            element={
              <ChatView
                models={models}
                defaultModel={defaultModel}
                onModelChange={setLastModel}
                onOpenSidebar={() => setSidebarOpen(true)}
                onNewChat={startNewChat}
              />
            }
          />
          <Route path="/p/:projectId" element={<ProjectView onOpenSidebar={() => setSidebarOpen(true)} />} />
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
