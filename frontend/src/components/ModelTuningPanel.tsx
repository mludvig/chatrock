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

// Answer length, thinking effort, and temperature — the controls that shape how the
// model reasons and writes, as opposed to what it's allowed to call out to (ToolsPanel).
// Top P is deliberately not offered here — it's rarely worth tuning independently of
// temperature and was mostly clutter.
export default function ModelTuningPanel({ caps, settings, onChange }: Props) {
  function set(patch: Partial<ModelSettings>) {
    onChange({ ...settings, ...patch })
  }

  const effort = settings.thinkingEffort ?? 'off'
  const answerLength = settings.answerLength ?? 'default'

  return (
    <div className="model-settings">
      <div className="pref-label">Model settings</div>

      <div className="model-setting-row">
        <label className="setting-label">
          <FontAwesomeIcon icon={faRulerHorizontal} />
          <span>Answer length</span>
          <span className="setting-value">{answerLength.charAt(0).toUpperCase() + answerLength.slice(1)}</span>
        </label>
        <div className="effort-buttons">
          {ANSWER_LENGTHS.map(len => (
            <button
              key={len}
              className={`effort-btn${answerLength === len ? ' active' : ''}`}
              onClick={() => set({ answerLength: len })}
            >
              {len.charAt(0).toUpperCase() + len.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {caps.thinking !== 'none' && (
        <div className="model-setting-row">
          <label
            className="setting-label"
            title="This model uses adaptive thinking — 'Off' disables it entirely; Low/Medium/High/Max controls how much effort is spent (token budget). Off → no thinking tokens; Low → minimal reasoning; Max → deep reasoning for hard problems."
          >
            <FontAwesomeIcon icon={faBrain} />
            <span>Thinking effort</span>
            <span className="setting-value">{effort === 'off' ? 'Off' : effort.charAt(0).toUpperCase() + effort.slice(1)}</span>
          </label>
          <div className="effort-buttons">
            {THINKING_EFFORTS.map(e => (
              <button
                key={e}
                className={`effort-btn${effort === e ? ' active' : ''}`}
                onClick={() => set({ thinkingEffort: e })}
              >
                {e === 'off' ? 'Off' : e.charAt(0).toUpperCase() + e.slice(1)}
              </button>
            ))}
          </div>
        </div>
      )}

      {caps.temperature && (
        <div className="model-setting-row">
          <label className="setting-label">
            <FontAwesomeIcon icon={faTemperatureHalf} />
            <span>Temperature</span>
            <span className="setting-value">{settings.temperature?.toFixed(2) ?? 'default'}</span>
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
