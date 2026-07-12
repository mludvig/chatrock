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

export function EffortRow<T extends string>({ label, options, value, onChange, format }: {
  label: string
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  format?: (v: T) => string
}) {
  return (
    <div className="pref-section">
      <div className="pref-label">{label}</div>
      <div className="effort-buttons">
        {options.map(opt => (
          <button
            key={opt}
            className={`effort-btn${value === opt ? ' active' : ''}`}
            onClick={() => onChange(opt)}
          >
            {format ? format(opt) : opt.charAt(0).toUpperCase() + opt.slice(1)}
          </button>
        ))}
      </div>
    </div>
  )
}
