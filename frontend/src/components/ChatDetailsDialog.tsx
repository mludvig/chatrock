import { useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faEyeSlash, faTrash, faHashtag, faMemory } from '@fortawesome/free-solid-svg-icons'
import type { Chat, ModelCapabilities, ModelSettings } from '../api/http'
import type { SaveStatus } from '../lib/useSaveStatus'
import { describeChatPrivacy } from '../lib/privacyDescription'
import Dialog from './Dialog'
import ToolsPanel from './ToolsPanel'
import ModelTuningPanel from './ModelTuningPanel'
import ShareTab from './ShareTab'
import SaveIndicator from './SaveIndicator'

// Item-scoped settings dialog — see docs/adr/0009-consolidate-item-scoped-settings-into-one-dialog.md.
// sensitive/ephemeral toggles: see docs/adr/0008-sensitive-and-ephemeral-are-independent-flags.md.
// "Update memory" toggle displays the inverse of the underlying `sensitive` flag — see
// docs/adr/0015-privacy-toggle-labels-and-sensitive-flag-mapping.md.
interface Props {
  open: boolean
  onClose: () => void
  isNew: boolean
  chat: Chat | null                 // null for a not-yet-created draft
  onRename: (title: string) => void
  sensitive: boolean
  ephemeral: boolean
  expiresAt?: string
  isProject: boolean
  onToggleSensitive: () => void
  onToggleEphemeral: () => void
  showTokenStats: boolean
  onToggleShowTokenStats: () => void
  caps: ModelCapabilities
  settings: ModelSettings
  onSettingsChange: (s: ModelSettings) => void
  systemPrompt: string
  onSystemPromptChange: (v: string) => void
  systemPromptSaveStatus?: SaveStatus
}

type Tab = 'settings' | 'info' | 'share'

export default function ChatDetailsDialog({
  open, onClose, isNew, chat, onRename,
  sensitive, ephemeral, expiresAt, isProject, onToggleSensitive, onToggleEphemeral,
  showTokenStats, onToggleShowTokenStats,
  caps, settings, onSettingsChange, systemPrompt, onSystemPromptChange, systemPromptSaveStatus,
}: Props) {
  // A draft chat has no title/summary yet, so there's nothing for an Info tab to
  // show — only a saved chat gets the tab bar; a draft just sees Settings directly.
  const [tab, setTab] = useState<Tab>('settings')
  useEffect(() => { if (open) setTab('settings') }, [open])

  const [titleDraft, setTitleDraft] = useState(chat?.title ?? '')
  useEffect(() => { if (open) setTitleDraft(chat?.title ?? '') }, [open, chat?.title])

  const hasInfo = !isNew
  // Sharing/export need a persisted chatId to hang share records and messages off of — a
  // not-yet-saved /c/new draft has nothing to share yet, same reasoning as the Info tab above.
  const hasShare = !isNew && !!chat?.chatId

  return (
    <Dialog open={open} onClose={onClose} title="Chat details">
      {hasInfo && (
        <div className="prefs-tabs">
          <button className={`prefs-tab${tab === 'settings' ? ' active' : ''}`} onClick={() => setTab('settings')}>
            Settings
          </button>
          <button className={`prefs-tab${tab === 'info' ? ' active' : ''}`} onClick={() => setTab('info')}>
            Info
          </button>
          {hasShare && (
            <button className={`prefs-tab${tab === 'share' ? ' active' : ''}`} onClick={() => setTab('share')}>
              Share
            </button>
          )}
        </div>
      )}

      {hasShare && tab === 'share' ? (
        <div className="prefs-tab-content">
          <ShareTab chatId={chat!.chatId} chatTitle={chat!.title} />
        </div>
      ) : hasInfo && tab === 'info' ? (
        <div className="prefs-tab-content">
          <div className="pref-section">
            <div className="pref-label">Title</div>
            <input
              className="pref-select"
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={() => { const t = titleDraft.trim(); if (t && t !== chat?.title) onRename(t) }}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            />
          </div>

          {(chat?.summary || (chat?.topics && chat.topics.length > 0)) && (
            <div className="pref-section">
              <div className="pref-label">Summary</div>
              {chat?.summary && <p className="prefs-desc">{chat.summary}</p>}
              {chat?.topics && chat.topics.length > 0 && (
                <div className="topic-chips">
                  {chat.topics.map(topic => (
                    <span key={topic} className="topic-chip">{topic}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="prefs-tab-content">
          <div className="pref-section">
            <div className="pref-label">
              Custom instructions for this chat
              {systemPromptSaveStatus && <SaveIndicator status={systemPromptSaveStatus} />}
            </div>
            <textarea
              className="pref-textarea"
              placeholder="Override global instructions for this chat only…"
              value={systemPrompt}
              onChange={e => onSystemPromptChange(e.target.value)}
            />
          </div>

          <div className="model-settings">
            <div className="pref-label">Privacy</div>
            <div className="model-setting-row model-setting-row--inline">
              <label className="setting-label" title="Controls this chat only. On: your saved memory is injected into this chat's system prompt. Off: nothing is read in — and nothing can be written out either, regardless of Update memory below.">
                <FontAwesomeIcon icon={faMemory} />
                <span>Use memory</span>
              </label>
              <button
                className={`toggle-btn${settings.memoryEnabled !== false ? ' active' : ''}`}
                onClick={() => onSettingsChange({ ...settings, memoryEnabled: settings.memoryEnabled === false ? true : false })}
                title="Toggle use memory"
              >
                {settings.memoryEnabled !== false ? 'On' : 'Off'}
              </button>
            </div>
            <div className="model-setting-row model-setting-row--inline">
              <label className="setting-label" title="On: new facts from this chat can be added to memory, and its summary stays current for search — the normal state. Off: this chat's content never gets written into memory, project memory, or search-indexed summaries, no matter what other chats do with theirs. Doesn't affect Use memory above — reading still works either way.">
                <FontAwesomeIcon icon={faEyeSlash} />
                <span>Update memory</span>
              </label>
              <button className={`toggle-btn${!sensitive ? ' active' : ''}`} onClick={onToggleSensitive} title="Toggle update memory">
                {!sensitive ? 'On' : 'Off'}
              </button>
            </div>
            <div className="model-setting-row model-setting-row--inline">
              <label
                className="setting-label"
                title={ephemeral && expiresAt ? `Expires ${new Date(expiresAt).toLocaleString()}.` : 'Deletes itself after a TTL.'}
              >
                <FontAwesomeIcon icon={faTrash} />
                <span>Auto-delete</span>
              </label>
              <button className={`toggle-btn${ephemeral ? ' active' : ''}`} onClick={onToggleEphemeral} title="Toggle auto-delete">
                {ephemeral ? 'On' : 'Off'}
              </button>
            </div>
            <p className="privacy-summary">
              {describeChatPrivacy({ memoryEnabled: settings.memoryEnabled !== false, sensitive, isProject, ephemeral, expiresAt })}
            </p>
          </div>

          <ToolsPanel settings={settings} onChange={onSettingsChange} hideMemory />
          <ModelTuningPanel caps={caps} settings={settings} onChange={onSettingsChange} />

          <div className="model-settings">
            <div className="model-setting-row model-setting-row--inline">
              <label className="setting-label" title="Shows per-message and running-total token counts under bubbles and above the input box. Usage is always recorded regardless of this setting — it only controls whether it's displayed.">
                <FontAwesomeIcon icon={faHashtag} />
                <span>Show token stats</span>
              </label>
              <button className={`toggle-btn${showTokenStats ? ' active' : ''}`} onClick={onToggleShowTokenStats} title="Toggle token stats display">
                {showTokenStats ? 'On' : 'Off'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  )
}
