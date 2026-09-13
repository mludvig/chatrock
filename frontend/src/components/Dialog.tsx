import { useEffect, useId, useRef } from 'react'

export default function Dialog({ open, onClose, title, children }: {
  open: boolean; onClose: () => void; title: string; children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const focusables = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex="0"]') ?? []).filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null)
    const frame = requestAnimationFrame(() => (ref.current?.querySelector<HTMLElement>('[autofocus], input, textarea') ?? focusables()[0] ?? ref.current)?.focus())
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current() }
      if (e.key === 'Tab') {
        const items = focusables(), first = items[0], last = items[items.length - 1]
        if (!first) { e.preventDefault(); ref.current?.focus() }
        else if (e.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus() }
  }, [open])
  if (!open) return null
  return <div className="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <div className="dialog-head"><span id={titleId} className="dialog-title">{title}</span><button className="btn-icon" onClick={onClose} title="Close" aria-label="Close">✕</button></div>
      <div className="dialog-body">{children}</div>
    </div>
  </div>
}
