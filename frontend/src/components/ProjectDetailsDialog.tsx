import type { Model, ModelSettings } from '../api/http'
import type { SaveStatus } from '../lib/useSaveStatus'
import Dialog from './Dialog'
import ToolsPanel from './ToolsPanel'
import ModelTuningPanel from './ModelTuningPanel'
import { ToggleRow } from './PrefControls'
import SaveIndicator from './SaveIndicator'

interface Props {
  open: boolean
  onClose: () => void
  projectName: string
  descDraft: string
  onDescChange: (v: string) => void
  onDescBlur: () => void
  descSaveStatus: SaveStatus
  instrDraft: string
  onInstrChange: (v: string) => void
  onInstrBlur: () => void
  instrSaveStatus: SaveStatus
  models: Model[]
  defaultModel: string
  onDefaultModelChange: (modelId: string) => void
  settings: ModelSettings
  onSettingsChange: (s: ModelSettings) => void
  memoryEnabled: boolean
  onToggleMemory: () => void
}

export default function ProjectDetailsDialog({
  open, onClose, projectName,
  descDraft, onDescChange, onDescBlur, descSaveStatus,
  instrDraft, onInstrChange, onInstrBlur, instrSaveStatus,
  models, defaultModel, onDefaultModelChange,
  settings, onSettingsChange,
  memoryEnabled, onToggleMemory,
}: Props) {
  return (
    <Dialog open={open} onClose={onClose} title={`Project details — ${projectName}`}>
      <div className="prefs-tab-content">
        <div className="pref-section">
          <div className="pref-label">Description<SaveIndicator status={descSaveStatus} /></div>
          <textarea
            className="pref-textarea"
            placeholder="What is this project about?"
            value={descDraft}
            onChange={e => onDescChange(e.target.value)}
            onBlur={onDescBlur}
          />
        </div>

        <div className="pref-section">
          <div className="pref-label">Instructions<SaveIndicator status={instrSaveStatus} /></div>
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
          title="When off, saved project facts are neither used nor updated. Files and instructions remain available."
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

        <ToolsPanel settings={settings} onChange={onSettingsChange} hideMemory />
        <ModelTuningPanel settings={settings} onChange={onSettingsChange} />
      </div>
    </Dialog>
  )
}
