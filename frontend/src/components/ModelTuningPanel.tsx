import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBrain, faRulerHorizontal } from '@fortawesome/free-solid-svg-icons'
import type { ModelCapabilities, ModelSettings } from '../api/http'
import { THINKING_EFFORTS } from '../api/http'

interface Props {
  caps: ModelCapabilities
  settings: ModelSettings
  onChange: (s: ModelSettings) => void
}

const ANSWER_LENGTHS = ['default', 'short', 'extensive'] as const
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// Answer length and thinking effort — the controls that shape how the model reasons and
// writes, as opposed to what it's allowed to call out to (ToolsPanel). Same icon+inline
// row shape as ToolsPanel throughout, so nothing in this dialog looks like it belongs to
// a different UI.
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
            {(caps.thinkingLevels ?? THINKING_EFFORTS).map(e => (
              <option key={e} value={e}>{e === 'off' ? 'Off' : capitalize(e)}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}
