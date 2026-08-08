import type { SaveStatus } from '../lib/useSaveStatus'

// Small inline autosave indicator shown next to a field label — see
// docs/adr/0012-explicit-save-status-indicator.md.
export default function SaveIndicator({ status }: { status: SaveStatus }) {
  if (status === 'idle') return null
  return (
    <span className={`save-indicator save-indicator--${status}`}>
      {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : 'Error'}
    </span>
  )
}
