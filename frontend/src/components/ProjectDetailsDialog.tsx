import type { Model, ModelCapabilities, ModelSettings } from '../api/http'
import Dialog from './Dialog'
import ToolsPanel from './ToolsPanel'
import ModelTuningPanel from './ModelTuningPanel'
import { ToggleRow } from './PrefControls'

interface Props {
  open: boolean
  onClose: () => void
  projectName: string
  descDraft: string
  onDescChange: (v: string) => void
  onDescBlur: () => void
  instrDraft: string
  onInstrChange: (v: string) => void
  onInstrBlur: () => void
  models: Model[]
  defaultModel: string
  onDefaultModelChange: (modelId: string) => void
  caps: ModelCapabilities
  settings: ModelSettings
  onSettingsChange: (s: ModelSettings) => void
  memoryEnabled: boolean
  onToggleMemory: () => void
}

export default function ProjectDetailsDialog({
  open, onClose, projectName,
  descDraft, onDescChange, onDescBlur,
  instrDraft, onInstrChange, onInstrBlur,
  models, defaultModel, onDefaultModelChange,
  caps, settings, onSettingsChange,
  memoryEnabled, onToggleMemory,
}: Props) {
  return (
    <Dialog open={open} onClose={onClose} title={`Project details — ${projectName}`}>
      <div className="prefs-tab-content">
        <div className="pref-section">
          <div className="pref-label">Description</div>
          <textarea
            className="pref-textarea"
            placeholder="What is this project about?"
            value={descDraft}
            onChange={e => onDescChange(e.target.value)}
            onBlur={onDescBlur}
          />
        </div>

        <div className="pref-section">
          <div className="pref-label">Instructions</div>
          <textarea
            className="pref-textarea"
            placeholder="Custom instructions applied to every chat in this project…"
            value={instrDraft}
            onChange={e => onInstrChange(e.target.value)}
            onBlur={onInstrBlur}
          />
        </div>

        <ToggleRow
          label="Project memory"
          title="When off, project memories are not injected and the manage_project_memory tool is disabled."
          on={memoryEnabled}
          onToggle={onToggleMemory}
        />

        <div className="pref-section">
          <div className="pref-label">Default model</div>
          <select
            className="pref-select"
            value={defaultModel}
            onChange={e => onDefaultModelChange(e.target.value)}
          >
            <option value="">Same as user default</option>
            {models.map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>

        <ToolsPanel settings={settings} onChange={onSettingsChange} />
        <ModelTuningPanel caps={caps} settings={settings} onChange={onSettingsChange} />
      </div>
    </Dialog>
  )
}
