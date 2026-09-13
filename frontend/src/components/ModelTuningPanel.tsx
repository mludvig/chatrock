import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faRulerHorizontal } from '@fortawesome/free-solid-svg-icons'
import type { ModelSettings } from '../api/http'

interface Props {
  settings: ModelSettings
  onChange: (s: ModelSettings) => void
}

const ANSWER_LENGTHS = ['default', 'short', 'extensive'] as const
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// Answer length shapes how the model writes. Reasoning controls live in the composer because
// they describe the next message — see docs/adr/0043-composer-owns-reasoning-controls.md.
export default function ModelTuningPanel({ settings, onChange }: Props) {
  function set(patch: Partial<ModelSettings>) {
    onChange({ ...settings, ...patch })
  }

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
    </div>
  )
}
