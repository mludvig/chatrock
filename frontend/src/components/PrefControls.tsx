// Small presentational rows shared by every "settings" surface (Defaults panel,
// Chat details dialog, Project details dialog) so a toggle or an effort picker
// looks and behaves identically no matter where it's rendered.

export function ToggleRow({ label, hint, on, onToggle, title }: {
  label: string
  hint?: string
  on: boolean
  onToggle: () => void
  title?: string
}) {
  return (
    <div className="pref-section">
      <div className="pref-row">
        <span className="pref-row-label" title={title}>{label}</span>
        <button className={`toggle-btn${on ? ' active' : ''}`} onClick={onToggle} title={title}>
          {on ? 'On' : 'Off'}
        </button>
      </div>
      {hint && <div className="pref-hint">{hint}</div>}
    </div>
  )
}

export function EffortRow<T extends string>({ label, options, value, onChange, format, title }: {
  label: string
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  format?: (v: T) => string
  title?: string
}) {
  return (
    <div className="pref-section">
      <div className="pref-row">
        <span className="pref-row-label" title={title}>{label}</span>
        <select className="model-select" value={value} onChange={e => onChange(e.target.value as T)} title={title}>
          {options.map(opt => (
            <option key={opt} value={opt}>{format ? format(opt) : opt.charAt(0).toUpperCase() + opt.slice(1)}</option>
          ))}
        </select>
      </div>
    </div>
  )
}
