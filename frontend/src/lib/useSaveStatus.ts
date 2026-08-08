import { useCallback, useRef, useState } from 'react'
import { useChatStore } from '../store/chatStore'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const SAVED_FLASH_MS = 2000

/**
 * Tracks the status of a debounced/on-blur autosave so the UI can show
 * "Saving…" / "Saved" instead of leaving the user guessing whether an edit
 * (e.g. custom instructions) persisted. `track(promise)` wraps any in-flight
 * save call; errors both flip status to 'error' and surface a toast, since
 * every call site here used to swallow failures silently.
 */
export function useSaveStatus() {
  const [status, setStatus] = useState<SaveStatus>('idle')
  const { pushToast } = useChatStore()
  const flashRef = useRef<number | null>(null)

  const track = useCallback((promise: Promise<unknown>) => {
    if (flashRef.current !== null) { clearTimeout(flashRef.current); flashRef.current = null }
    setStatus('saving')
    promise.then(() => {
      setStatus('saved')
      flashRef.current = window.setTimeout(() => setStatus('idle'), SAVED_FLASH_MS)
    }).catch(err => {
      setStatus('error')
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushToast])

  return { status, track }
}
