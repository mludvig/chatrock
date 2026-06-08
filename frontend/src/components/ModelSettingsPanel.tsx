import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBrain, faTemperatureHalf, faSlidersH } from '@fortawesome/free-solid-svg-icons'
import type { ModelCapabilities, ModelSettings } from '../api/http'
import { THINKING_EFFORTS } from '../api/http'

interface Props {
  caps: ModelCapabilities
  settings: ModelSettings
  onChange: (s: ModelSettings) => void
}

export default function ModelSettingsPanel({ caps, settings, onChange }: Props) {
  const hasAny = caps.temperature || caps.topP || caps.topK || caps.thinking !== 'none'
  if (!hasAny) return null

  function set(patch: Partial<ModelSettings>) {
    onChange({ ...settings, ...patch })
  }

  const effort = settings.thinkingEffort ?? 'off'

  return (
    <div className="model-settings">
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

      {caps.topP && (
        <div className="model-setting-row">
          <label className="setting-label">
            <FontAwesomeIcon icon={faSlidersH} />
            <span>Top P</span>
            <span className="setting-value">{settings.topP?.toFixed(2) ?? 'default'}</span>
          </label>
          <input
            type="range"
            className="setting-slider"
            min={0} max={1} step={0.01}
            value={settings.topP ?? 1}
            onChange={e => set({ topP: Number(e.target.value) })}
          />
        </div>
      )}

      {caps.thinking !== 'none' && (
        <div className="model-setting-row">
          <label className="setting-label">
            <FontAwesomeIcon icon={faBrain} />
            <span>Thinking</span>
            <span className="setting-value">{effort === 'off' ? 'Off' : effort}</span>
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
    </div>
  )
}
