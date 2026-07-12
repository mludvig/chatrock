import { useEffect } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faXmark } from '@fortawesome/free-solid-svg-icons'

// Shared modal shell for "details" dialogs (Chat details, Project details, and
// anything similar later). Centered on desktop; collapses to a full-width bottom
// sheet on mobile via CSS (see .dialog-backdrop / .dialog in app.scss).
export default function Dialog({ open, onClose, title, children }: {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-head">
          <span className="dialog-title">{title}</span>
          <button className="btn-icon" onClick={onClose} title="Close">
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
        <div className="dialog-body">
          {children}
        </div>
      </div>
    </div>
  )
}
