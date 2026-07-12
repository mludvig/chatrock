import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBrain, faTemperatureHalf, faRulerHorizontal } from '@fortawesome/free-solid-svg-icons'
import type { ModelCapabilities, ModelSettings } from '../api/http'
import { THINKING_EFFORTS } from '../api/http'

interface Props {
  caps: ModelCapabilities
  settings: ModelSettings
  onChange: (s: ModelSettings) => void
}

const ANSWER_LENGTHS = ['default', 'short', 'extensive'] as const
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// Answer length, thinking effort, and temperature — the controls that shape how the
// model reasons and writes, as opposed to what it's allowed to call out to (ToolsPanel).
// Same icon+inline row shape as ToolsPanel throughout, so nothing in this dialog looks
// like it belongs to a different UI. Top P is deliberately not offered here — it's
// rarely worth tuning independently of temperature and was mostly clutter.
export default function ModelTuningPanel({ caps, settings, onChange }: Props) {
  function set(patch: Partial<ModelSettings>) {
    onChange({ ...settings, ...patch })
  }

  const effort = settings.thinkingEffort ?? 'off'
  const answerLength = settings.answerLength ?? 'default'

  return (
    <div className="model-settings">
      <div className="pref-label">Model settings</div>

      <div className="model-setting-row model-setting-row--inline">
        <label className="setting-label">
          <FontAwesomeIcon icon={faRulerHorizontal} />
          <span>Answer length</span>
        </label>
        <select className="model-select" value={answerLength} onChange={e => set({ answerLength: e.target.value as typeof answerLength })}>
          {ANSWER_LENGTHS.map(len => (
            <option key={len} value={len}>{capitalize(len)}</option>
          ))}
        </select>
      </div>

      {caps.thinking !== 'none' && (
        <div className="model-setting-row model-setting-row--inline">
          <label
            className="setting-label"
            title="This model uses adaptive thinking — 'Off' disables it entirely; Low/Medium/High/Max controls how much effort is spent (token budget). Off → no thinking tokens; Low → minimal reasoning; Max → deep reasoning for hard problems."
          >
            <FontAwesomeIcon icon={faBrain} />
            <span>Thinking effort</span>
          </label>
          <select className="model-select" value={effort} onChange={e => set({ thinkingEffort: e.target.value as typeof effort })}>
            {THINKING_EFFORTS.map(e => (
              <option key={e} value={e}>{e === 'off' ? 'Off' : capitalize(e)}</option>
            ))}
          </select>
        </div>
      )}

      {caps.temperature && (
        <div className="model-setting-row">
          <label className="setting-label">
            <FontAwesomeIcon icon={faTemperatureHalf} />
            <span>Temperature</span>
            <button
              type="button"
              className="setting-value"
              disabled={settings.temperature === undefined}
              onClick={() => set({ temperature: undefined })}
              title={settings.temperature === undefined ? undefined : 'Click to reset to default'}
            >
              {settings.temperature?.toFixed(2) ?? 'default'}
            </button>
          </label>
          <input
            type="range"
            className="setting-slider"
            min={0} max={1} step={0.01}
            value={settings.temperature ?? 1}
            onChange={e => set({ temperature: Number(e.target.value) })}
          />
        </div>
      )}
    </div>
  )
}
