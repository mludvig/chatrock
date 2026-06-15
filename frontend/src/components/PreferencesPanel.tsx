import { useEffect, useRef, useState } from 'react'
import { api } from '../api/http'
import type { UserPreferences, ModelCapabilities } from '../api/http'
import { THINKING_EFFORTS } from '../api/http'
import { useChatStore } from '../store/chatStore'
import ModelSettingsPanel from './ModelSettingsPanel'

export default function PreferencesPanel() {
  const {
    models, userPreferences, setUserPreferences,
    currentChatId, draftModelSettings, draftSystemPrompt,
    setDraftModelSettings, setDraftSystemPrompt,
    updateChatSettings, updateChatSystemPrompt, chats,
  } = useChatStore()

  const [tab, setTab] = useState<'defaults' | 'chat'>('defaults')
  const [prefs, setPrefs] = useState<UserPreferences>(userPreferences)
  const [saved, setSaved] = useState(false)
  const debounceRef = useRef<number | null>(null)
  const chatDebounceRef = useRef<number | null>(null)
  const initialLoadRef = useRef(false)

  // Load preferences from server on mount
  useEffect(() => {
    api.getPreferences().then(res => {
      setPrefs(res.preferences)
      setUserPreferences(res.preferences)
      initialLoadRef.current = true
    }).catch(() => {
      initialLoadRef.current = true
    })
  }, [setUserPreferences])

  // Auto-save defaults with 800ms debounce
  useEffect(() => {
    if (!initialLoadRef.current) return
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      api.savePreferences(prefs).then(() => {
        setUserPreferences(prefs)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }).catch(() => {})
    }, 800)
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs])

  function patch(update: Partial<UserPreferences>) {
    setPrefs(p => ({ ...p, ...update }))
  }

  const isNew = !currentChatId
  const activeChat = currentChatId ? chats.find(c => c.chatId === currentChatId) : null

  const selectedModelDef = models.find(m => m.id === prefs.defaultModel)
  const selectedCaps = selectedModelDef?.capabilities
  const supportsThinking = selectedCaps ? selectedCaps.thinking !== 'none' : false
  const effort = prefs.thinkingEffort ?? 'off'

  // Derive caps for the active chat's model
  const activeChatModelId = isNew ? '' : (activeChat?.model ?? '')
  const activeChatModelDef = models.find(m => m.id === activeChatModelId)
  const activeCaps: ModelCapabilities = activeChatModelDef?.capabilities
    ?? { temperature: true, topP: true, topK: false, thinking: 'none', attachments: true }

  function handleChatInstructionsChange(value: string) {
    if (isNew) {
      setDraftSystemPrompt(value)
    } else if (currentChatId) {
      updateChatSystemPrompt(currentChatId, value)
      if (chatDebounceRef.current !== null) clearTimeout(chatDebounceRef.current)
      chatDebounceRef.current = window.setTimeout(() => {
        api.updateSystemPrompt(currentChatId, value).catch(() => {})
      }, 800)
    }
  }

  function handleChatSettingsChange(newSettings: import('../api/http').ModelSettings) {
    setDraftModelSettings(newSettings)
    if (!isNew && currentChatId) {
      updateChatSettings(currentChatId, newSettings)
      if (chatDebounceRef.current !== null) clearTimeout(chatDebounceRef.current)
      chatDebounceRef.current = window.setTimeout(() => {
        api.updateChatSettings(currentChatId, newSettings).catch(() => {})
      }, 800)
    }
  }

  return (
    <div className="prefs-panel">
      <div className="prefs-tabs">
        <button
          className={`prefs-tab${tab === 'defaults' ? ' active' : ''}`}
          onClick={() => setTab('defaults')}
        >
          Defaults
        </button>
        <button
          className={`prefs-tab${tab === 'chat' ? ' active' : ''}`}
          onClick={() => setTab('chat')}
        >
          This chat
        </button>
      </div>

      {tab === 'defaults' && (
        <div className="prefs-tab-content">
          <p className="prefs-desc">Applies to all chats as defaults. Per-chat settings override these.</p>

          {/* Custom instructions */}
          <div className="pref-section">
            <div className="pref-label">Custom instructions</div>
            <textarea
              className="pref-textarea"
              placeholder="Describe how you'd like the assistant to behave (e.g. 'You are a senior software engineer...', 'Keep answers concise', 'Always respond in French')"
              value={prefs.persona ?? ''}
              onChange={e => patch({ persona: e.target.value })}
            />
          </div>

          {/* Default model */}
          <div className="pref-section">
            <div className="pref-label">Default model</div>
            <select
              className="pref-select"
              value={prefs.defaultModel ?? ''}
              onChange={e => patch({ defaultModel: e.target.value || undefined })}
            >
              <option value="">Use app default</option>
              {models.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          {/* Thinking effort */}
          {supportsThinking && (
            <div className="pref-section">
              <div className="pref-label">Thinking effort</div>
              <div className="effort-buttons">
                {THINKING_EFFORTS.map(e => (
                  <button
                    key={e}
                    className={`effort-btn${effort === e ? ' active' : ''}`}
                    onClick={() => patch({ thinkingEffort: e })}
                  >
                    {e === 'off' ? 'Off' : e.charAt(0).toUpperCase() + e.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Web search */}
          <div className="pref-section">
            <div className="pref-row">
              <span className="pref-row-label">Web search</span>
              <button
                className={`toggle-btn${prefs.webSearch !== false ? ' active' : ''}`}
                onClick={() => patch({ webSearch: prefs.webSearch === false ? true : false })}
              >
                {prefs.webSearch !== false ? 'On' : 'Off'}
              </button>
            </div>
          </div>

          {/* Answer length */}
          <div className="pref-section">
            <div className="pref-label">Answer length</div>
            <div className="effort-buttons">
              {(['default', 'short', 'extensive'] as const).map(len => (
                <button
                  key={len}
                  className={`effort-btn${(prefs.answerLength ?? 'default') === len ? ' active' : ''}`}
                  onClick={() => patch({ answerLength: len })}
                >
                  {len.charAt(0).toUpperCase() + len.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Show token stats */}
          <div className="pref-section">
            <div className="pref-row">
              <span className="pref-row-label">Show token stats</span>
              <button
                className={`toggle-btn${prefs.showTokenStats !== false ? ' active' : ''}`}
                onClick={() => patch({ showTokenStats: prefs.showTokenStats === false ? true : false })}
              >
                {prefs.showTokenStats !== false ? 'On' : 'Off'}
              </button>
            </div>
          </div>

          {/* Inject current date */}
          <div className="pref-section">
            <div className="pref-row">
              <span className="pref-row-label">Inject current date</span>
              <button
                className={`toggle-btn${prefs.injectCurrentDate !== false ? ' active' : ''}`}
                onClick={() => patch({ injectCurrentDate: prefs.injectCurrentDate === false ? true : false })}
              >
                {prefs.injectCurrentDate !== false ? 'On' : 'Off'}
              </button>
            </div>
          </div>

          <div className="saved-indicator">{saved ? 'Saved' : ''}</div>
        </div>
      )}

      {tab === 'chat' && (
        <div className="prefs-tab-content">
          <p className="prefs-desc">Overrides the defaults for this chat only.</p>

          <div className="pref-section">
            <div className="pref-label">Custom instructions</div>
            <textarea
              className="pref-textarea"
              placeholder="Override global instructions for this chat only…"
              value={isNew ? draftSystemPrompt : (activeChat?.systemPrompt ?? '')}
              onChange={e => handleChatInstructionsChange(e.target.value)}
            />
          </div>

          <ModelSettingsPanel
            caps={activeCaps}
            settings={draftModelSettings}
            onChange={handleChatSettingsChange}
          />
        </div>
      )}
    </div>
  )
}
