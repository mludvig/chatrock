import { useEffect } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faXmark } from '@fortawesome/free-solid-svg-icons'
import { useChatStore } from '../store/chatStore'

const AUTO_DISMISS_MS = 3500

export default function Toaster() {
  const { toasts, dismissToast } = useChatStore()

  useEffect(() => {
    if (toasts.length === 0) return
    const newest = toasts[toasts.length - 1]
    const timer = setTimeout(() => dismissToast(newest.id), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toasts, dismissToast])

  if (toasts.length === 0) return null

  return (
    <div className="toaster">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          {t.items && t.items.length > 0 ? (
            <div className="toast-memory-cards">
              {t.items.map((mem, i) => (
                <div key={i} className="memory-update-card">
                  <div className="memory-update-head">
                    <span className="memory-update-op">
                      {mem.op === 'forget' ? 'Forgot' : mem.op === 'update' ? 'Updated' : 'Remembered'}
                      {mem.scope === 'project' ? ' project memory' : ' memory'}
                    </span>
                    {mem.category && <span className="memory-update-cat">{mem.category}</span>}
                  </div>
                  {mem.text && <div className="memory-update-text">{mem.text}</div>}
                </div>
              ))}
            </div>
          ) : (
            <span className="toast-text">{t.text}</span>
          )}
          <button className="toast-dismiss" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      ))}
    </div>
  )
}
