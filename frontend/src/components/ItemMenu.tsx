import { useEffect, useRef } from 'react'

export default function ItemMenu({ label, children }: { label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) ref.current?.removeAttribute('open') }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])
  return <details ref={ref} className="item-menu" onClick={e => e.stopPropagation()} onKeyDown={e => {
    if (e.key === 'Escape') { ref.current?.removeAttribute('open'); ref.current?.querySelector('summary')?.focus() }
  }}>
    <summary aria-label={label} title={label}>•••</summary>
    <div className="item-menu-content" onClick={e => { if ((e.target as HTMLElement).closest('button')) ref.current?.removeAttribute('open') }}>{children}</div>
  </details>
}
