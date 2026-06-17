import { useEffect, useRef, useState } from 'react'
import { api } from '../api/http'
import type { UserPreferences, ModelCapabilities, ModelSettings, Project } from '../api/http'
import { THINKING_EFFORTS } from '../api/http'
import { useChatStore } from '../store/chatStore'
import ModelSettingsPanel from './ModelSettingsPanel'

export default function PreferencesPanel() {
  const {
    models, userPreferences, setUserPreferences,
    currentChatId, draftModelSettings, draftSystemPrompt,
    setDraftModelSettings, setDraftSystemPrompt,
    updateChatSettings, updateChatSystemPrompt, chats,
    projects, updateProject,
  } = useChatStore()

  const activeChat = currentChatId ? chats.find(c => c.chatId === currentChatId) : null
  const activeProject = activeChat?.projectId
    ? projects.find(p => p.projectId === activeChat.projectId)
    : null

  type Tab = 'defaults' | 'project' | 'chat'

  const [tab, setTab] = useState<Tab>('chat')
  const [prefs, setPrefs] = useState<UserPreferences>(userPreferences)
  const [saved, setSaved] = useState(false)
  const debounceRef = useRef<number | null>(null)
  const chatInstructionsDebounceRef = useRef<number | null>(null)
  const chatSettingsDebounceRef = useRef<number | null>(null)
  const initialLoadRef = useRef(false)

  // Project tab state
  const [projectDraft, setProjectDraft] = useState<Partial<Project>>({})
  const projectDebounceRef = useRef<number | null>(null)
  const projectDraftInitRef = useRef<string | null>(null)

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

  // Seed project draft when active project changes
  useEffect(() => {
    if (!activeProject) return
    if (projectDraftInitRef.current === activeProject.projectId) return
    projectDraftInitRef.current = activeProject.projectId
    setProjectDraft({
      instructions:  activeProject.instructions,
      defaultModel:  activeProject.defaultModel,
      modelSettings: activeProject.modelSettings,
      memoryEnabled: activeProject.memoryEnabled,
    })
  }, [activeProject])

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

  const selectedModelDef = models.find(m => m.id === prefs.defaultModel)
  const selectedCaps = selectedModelDef?.capabilities
  const supportsThinking = selectedCaps ? selectedCaps.thinking !== 'none' : false
  const effort = prefs.thinkingEffort ?? 'off'

  // Derive caps for the active chat's model
  const activeChatModelId = isNew ? '' : (activeChat?.model ?? '')
  const activeChatModelDef = models.find(m => m.id === activeChatModelId)
  const activeCaps: ModelCapabilities = activeChatModelDef?.capabilities
    ?? { temperature: true, topP: true, topK: false, thinking: 'none', attachments: true }

  // Caps for the project's default model
  const projectModelId = projectDraft.defaultModel ?? ''
  const projectModelDef = models.find(m => m.id === projectModelId)
  const projectCaps: ModelCapabilities = projectModelDef?.capabilities
    ?? { temperature: true, topP: true, topK: false, thinking: 'none', attachments: true }
  const projectSupportsThinking = projectCaps.thinking !== 'none'

  function handleChatInstructionsChange(value: string) {
    if (isNew) {
      setDraftSystemPrompt(value)
    } else if (currentChatId) {
      updateChatSystemPrompt(currentChatId, value)
      if (chatInstructionsDebounceRef.current !== null) clearTimeout(chatInstructionsDebounceRef.current)
      chatInstructionsDebounceRef.current = window.setTimeout(() => {
        api.updateSystemPrompt(currentChatId, value).catch(() => {})
      }, 800)
    }
  }

  function handleChatSettingsChange(newSettings: ModelSettings) {
    setDraftModelSettings(newSettings)
    if (!isNew && currentChatId) {
      updateChatSettings(currentChatId, newSettings)
      if (chatSettingsDebounceRef.current !== null) clearTimeout(chatSettingsDebounceRef.current)
      chatSettingsDebounceRef.current = window.setTimeout(() => {
        api.updateChatSettings(currentChatId, newSettings).catch(() => {})
      }, 800)
    }
  }

  function patchProjectDraft(update: Partial<Project>) {
    if (!activeProject) return
    setProjectDraft(prev => {
      const next = { ...prev, ...update }
      updateProject(activeProject.projectId, next as Partial<Project>)
      if (projectDebounceRef.current !== null) clearTimeout(projectDebounceRef.current)
      projectDebounceRef.current = window.setTimeout(() => {
        api.updateProject(activeProject.projectId, next as Parameters<typeof api.updateProject>[1]).catch(() => {})
      }, 800)
      return next
    })
  }

  function patchProjectModelSettings(update: Partial<ModelSettings>) {
    patchProjectDraft({ modelSettings: { ...(projectDraft.modelSettings ?? {}), ...update } })
  }

  useEffect(() => {
    return () => {
      if (chatInstructionsDebounceRef.current !== null) clearTimeout(chatInstructionsDebounceRef.current)
      if (chatSettingsDebounceRef.current !== null) clearTimeout(chatSettingsDebounceRef.current)
      if (projectDebounceRef.current !== null) clearTimeout(projectDebounceRef.current)
    }
  }, [])

  // If the project disappears (chat moved out), fall back to 'chat' tab
  useEffect(() => {
    if (!activeProject && tab === 'project') setTab('chat')
  }, [activeProject, tab])

  return (
    <div className="prefs-panel">
      <div className="prefs-tabs">
        <button
          className={`prefs-tab${tab === 'defaults' ? ' active' : ''}`}
          onClick={() => setTab('defaults')}
        >
          Defaults
        </button>
        {activeProject && (
          <button
            className={`prefs-tab${tab === 'project' ? ' active' : ''}`}
            onClick={() => setTab('project')}
          >
            This project
          </button>
        )}
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

          {/* Inject current timestamp */}
          <div className="pref-section">
            <div className="pref-row">
              <span className="pref-row-label">Inject current timestamp</span>
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

      {tab === 'project' && activeProject && (
        <div className="prefs-tab-content">
          <p className="prefs-desc">Applies to all chats in <strong>{activeProject.name}</strong>. Per-chat settings override these.</p>

          {/* Project instructions */}
          <div className="pref-section">
            <div className="pref-label">Project instructions</div>
            <textarea
              className="pref-textarea"
              placeholder="Context or instructions for the assistant in every chat within this project…"
              value={projectDraft.instructions ?? ''}
              onChange={e => patchProjectDraft({ instructions: e.target.value })}
            />
          </div>

          {/* Project default model */}
          <div className="pref-section">
            <div className="pref-label">Default model</div>
            <select
              className="pref-select"
              value={projectDraft.defaultModel ?? ''}
              onChange={e => patchProjectDraft({ defaultModel: e.target.value || undefined })}
            >
              <option value="">Same as user default</option>
              {models.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          {/* Thinking effort */}
          {projectSupportsThinking && (
            <div className="pref-section">
              <div className="pref-label">Thinking effort</div>
              <div className="effort-buttons">
                {THINKING_EFFORTS.map(e => (
                  <button
                    key={e}
                    className={`effort-btn${(projectDraft.modelSettings?.thinkingEffort ?? 'off') === e ? ' active' : ''}`}
                    onClick={() => patchProjectModelSettings({ thinkingEffort: e })}
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
                className={`toggle-btn${projectDraft.modelSettings?.webSearch !== false ? ' active' : ''}`}
                onClick={() => patchProjectModelSettings({ webSearch: projectDraft.modelSettings?.webSearch === false ? true : false })}
              >
                {projectDraft.modelSettings?.webSearch !== false ? 'On' : 'Off'}
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
                  className={`effort-btn${(projectDraft.modelSettings?.answerLength ?? 'default') === len ? ' active' : ''}`}
                  onClick={() => patchProjectModelSettings({ answerLength: len })}
                >
                  {len.charAt(0).toUpperCase() + len.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Project memory */}
          <div className="pref-section">
            <div className="pref-row">
              <span className="pref-row-label">Project memory</span>
              <button
                className={`toggle-btn${projectDraft.memoryEnabled !== false ? ' active' : ''}`}
                onClick={() => patchProjectDraft({ memoryEnabled: projectDraft.memoryEnabled === false ? true : false })}
              >
                {projectDraft.memoryEnabled !== false ? 'On' : 'Off'}
              </button>
            </div>
            <div className="pref-hint">When off, project memories are not injected and the manage_project_memory tool is disabled.</div>
          </div>
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

          {/* Answer length */}
          <div className="pref-section">
            <div className="pref-label">Answer length</div>
            <div className="effort-buttons">
              {(['default', 'short', 'extensive'] as const).map(len => (
                <button
                  key={len}
                  className={`effort-btn${(draftModelSettings.answerLength ?? 'default') === len ? ' active' : ''}`}
                  onClick={() => handleChatSettingsChange({ ...draftModelSettings, answerLength: len })}
                >
                  {len.charAt(0).toUpperCase() + len.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Inject current timestamp */}
          <div className="pref-section">
            <div className="pref-row">
              <span className="pref-row-label">Inject current timestamp</span>
              <button
                className={`toggle-btn${draftModelSettings.injectCurrentDate !== false ? ' active' : ''}`}
                onClick={() => handleChatSettingsChange({ ...draftModelSettings, injectCurrentDate: draftModelSettings.injectCurrentDate === false ? true : false })}
              >
                {draftModelSettings.injectCurrentDate !== false ? 'On' : 'Off'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
