import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { api, setAccessToken } from './api/http'
import { useChatStore } from './store/chatStore'
import Sidebar from './components/Sidebar'
import ChatView from './components/ChatView'
import NewChatModal from './components/NewChatModal'
import './app.scss'

export default function App() {
  const auth = useAuth()
  const {
    chats, setChats, addChat, setActiveChat, setModels, models,
    setLoading, loading, renameChat,
  } = useChatStore()
  const [showNewChat, setShowNewChat] = useState(false)

  const accessToken = auth.user?.access_token ?? ''
  const userName = auth.user?.profile.email ?? auth.user?.profile.sub ?? 'User'

  // Sync token to HTTP client whenever it changes
  useEffect(() => {
    setAccessToken(accessToken)
  }, [accessToken])

  // Initial data load after sign-in
  useEffect(() => {
    if (!auth.isAuthenticated || !accessToken) return
    setLoading(true)
    Promise.all([
      api.listChats(),
      api.listModels(),
    ]).then(([chatsRes, modelsRes]) => {
      // Sort by updatedAt descending
      const sorted = chatsRes.chats.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )
      setChats(sorted)
      setModels(modelsRes.models)
    }).finally(() => setLoading(false))
  }, [auth.isAuthenticated, accessToken, setChats, setModels, setLoading])

  // WS: register title-updated handler (store already wired in ChatView)

  // ── Auth states ──────────────────────────────────────────────────────────
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
          <h1>🪨 Chatrock</h1>
          <p>Sign in to start chatting.</p>
          <button className="btn-primary btn-lg" onClick={() => auth.signinRedirect()}>
            Sign in
          </button>
        </div>
      </div>
    )
  }

  // ── Authenticated ────────────────────────────────────────────────────────
  async function handleNewChat(model: string, systemPrompt: string) {
    setShowNewChat(false)
    const res = await api.createChat(model, systemPrompt)
    const now = new Date().toISOString()
    const selectedModel = models.find(m => m.id === model)
    addChat({
      chatId: res.chatId,
      title: 'New Chat',
      model,
      systemPrompt,
      createdAt: now,
      updatedAt: now,
    })
    setActiveChat(res.chatId)
    // Sidebar will show the title updated via WS titleUpdated event
    void selectedModel // suppress unused warning
  }

  const defaultModel = models[1]?.id ?? models[0]?.id ?? ''

  return (
    <div className="layout">
      <Sidebar
        userName={userName}
        onNewChat={() => setShowNewChat(true)}
        onSignOut={() => auth.signoutRedirect()}
      />
      <main className="main">
        {loading ? (
          <div className="chat-empty"><p>Loading…</p></div>
        ) : (
          <ChatView accessToken={accessToken} />
        )}
      </main>
      {showNewChat && (
        <NewChatModal
          models={models}
          defaultModel={defaultModel}
          onConfirm={handleNewChat}
          onCancel={() => setShowNewChat(false)}
        />
      )}
    </div>
  )
}
