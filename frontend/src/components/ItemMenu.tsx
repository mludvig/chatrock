import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export default function ItemMenu({ label, children }: { label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 8 })
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); ref.current?.querySelector('summary')?.focus() }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('scroll', close, true)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('scroll', close, true)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  useLayoutEffect(() => {
    if (!open || !menu.current || !ref.current) return
    const anchor = ref.current.getBoundingClientRect()
    const popup = menu.current.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(anchor.right - popup.width, window.innerWidth - popup.width - 8)),
      top: Math.max(8, anchor.bottom + popup.height + 8 <= window.innerHeight ? anchor.bottom + 4 : anchor.top - popup.height - 4),
    })
    menu.current.querySelector<HTMLElement>('button, a')?.focus({ preventScroll: true })
  }, [open])
  // Body placement avoids clipping by either sidebar's scrollable list. See ADR 0045.
  return <details ref={ref} className="item-menu" open={open} onToggle={e => setOpen(e.currentTarget.open)} onClick={e => e.stopPropagation()}>
    <summary aria-label={label} title={label}>•••</summary>
    {open && createPortal(<div ref={menu} className="item-menu-content" aria-label={label} role="group"
      style={{ position: 'fixed', right: 'auto', ...position, maxHeight: 'calc(100dvh - 16px)', overflowY: 'auto' }}
      onClick={e => {
        if ((e.target as HTMLElement).closest('button, a')) {
          setOpen(false)
          ref.current?.querySelector('summary')?.focus({ preventScroll: true })
        }
      }}
    >{children}</div>, document.body)}
  </details>
}
