import { useEffect, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faSlidersH } from '@fortawesome/free-solid-svg-icons'
import { api } from '../api/http'
import type { UserPreferences } from '../api/http'
import { THINKING_EFFORTS, RESEARCH_DEPTHS } from '../api/http'
import { useChatStore } from '../store/chatStore'
import { ToggleRow, EffortRow } from './PrefControls'
import SaveIndicator from './SaveIndicator'
import { useSaveStatus } from '../lib/useSaveStatus'

// App-wide defaults only — per-chat and per-project overrides now live in their own
// "details" dialogs (ChatDetailsDialog / ProjectDetailsDialog), reachable from the
// chat header cog and the project page's gear respectively. Keeping this panel scoped
// to just Defaults means there's exactly one place values here can come from.
export default function PreferencesPanel() {
  const { models, userPreferences, setUserPreferences } = useChatStore()

  const [prefs, setPrefs] = useState<UserPreferences>(userPreferences)
  const { status: saveStatus, track: trackSave } = useSaveStatus()
  const debounceRef = useRef<number | null>(null)
  // Gates both the mount-time fetch below and the auto-save effect: true once the user
  // has made a real edit. Guards two races at once — (1) the fetch resolving after a quick
  // edit must not clobber it, and (2) an edit made before the fetch resolves must still
  // schedule a save (a plain "has the initial GET completed" flag would miss this, since
  // a ref flip alone doesn't re-trigger the save effect).
  const editedRef = useRef(false)

  useEffect(() => {
    api.getPreferences().then(res => {
      if (!editedRef.current) setPrefs(res.preferences)
      setUserPreferences(res.preferences)
    }).catch(() => {})
  }, [setUserPreferences])

  useEffect(() => {
    if (!editedRef.current) return
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      trackSave(api.savePreferences(prefs).then(() => { setUserPreferences(prefs) }))
    }, 800)
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs])

  function patch(update: Partial<UserPreferences>) {
    editedRef.current = true
    setPrefs(p => ({ ...p, ...update }))
  }

  const selectedModelDef = models.find(m => m.id === prefs.defaultModel)
  const supportsThinking = selectedModelDef ? selectedModelDef.capabilities.thinking !== 'none' : false

  return (
    <div className="prefs-panel">
      <div className="panel-header">
        <FontAwesomeIcon icon={faSlidersH} />
        <span>Defaults</span>
      </div>
      <div className="prefs-tab-content">
        <p className="prefs-desc">Applies to all chats. A chat's or project's own details dialog can override any of these.</p>

        <div className="pref-section">
          <div className="pref-label">Custom instructions</div>
          <textarea
            className="pref-textarea"
            placeholder="Describe how you'd like the assistant to behave (e.g. 'You are a senior software engineer...', 'Keep answers concise', 'Always respond in French')"
            value={prefs.persona ?? ''}
            onChange={e => patch({ persona: e.target.value })}
          />
        </div>

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

        {supportsThinking && (
          <EffortRow
            label="Thinking effort"
            options={THINKING_EFFORTS}
            value={prefs.thinkingEffort ?? 'off'}
            onChange={v => patch({ thinkingEffort: v })}
            format={e => e === 'off' ? 'Off' : e.charAt(0).toUpperCase() + e.slice(1)}
          />
        )}

        <EffortRow
          label="Research depth"
          options={RESEARCH_DEPTHS}
          value={prefs.researchDepth ?? 'brief'}
          onChange={v => patch({ researchDepth: v })}
          format={d => d === 'brief' ? 'Brief' : d === 'extended' ? 'Extended' : 'Deep'}
          title="How many tool rounds the model budgets for research before it must answer. Brief is the default. See docs/adr/0020-research-depth-and-budget-pacing.md."
        />

        <ToggleRow
          label="Web search"
          on={prefs.webSearchEnabled !== false}
          onToggle={() => patch({ webSearchEnabled: prefs.webSearchEnabled === false ? true : false })}
        />

        <EffortRow
          label="Web search provider"
          options={['jina', 'agentcore'] as const}
          value={prefs.webSearchProvider ?? 'jina'}
          onChange={v => patch({ webSearchProvider: v })}
          format={p => p === 'jina' ? 'Jina' : 'AgentCore'}
        />

        <ToggleRow
          label="Browser — Core"
          on={prefs.browserCoreEnabled !== false}
          onToggle={() => patch({ browserCoreEnabled: prefs.browserCoreEnabled === false ? true : false })}
        />
        <ToggleRow
          label="Browser — Extended"
          on={prefs.browserExtendedEnabled === true}
          onToggle={() => patch({ browserExtendedEnabled: prefs.browserExtendedEnabled === true ? false : true })}
        />

        <EffortRow
          label="Answer length"
          options={['default', 'short', 'extensive'] as const}
          value={prefs.answerLength ?? 'default'}
          onChange={v => patch({ answerLength: v })}
        />

        <ToggleRow
          label="Show token stats"
          on={prefs.showTokenStats === true}
          onToggle={() => patch({ showTokenStats: prefs.showTokenStats === true ? false : true })}
        />
        <ToggleRow
          label="Inject current timestamp"
          on={prefs.injectCurrentDate !== false}
          onToggle={() => patch({ injectCurrentDate: prefs.injectCurrentDate === false ? true : false })}
        />

        <div className="saved-indicator"><SaveIndicator status={saveStatus} /></div>
      </div>
    </div>
  )
}
