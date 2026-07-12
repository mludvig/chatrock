import { useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faEyeSlash, faTrash } from '@fortawesome/free-solid-svg-icons'
import type { Chat, ModelCapabilities, ModelSettings } from '../api/http'
import Dialog from './Dialog'
import ToolsPanel from './ToolsPanel'
import ModelTuningPanel from './ModelTuningPanel'

interface Props {
  open: boolean
  onClose: () => void
  isNew: boolean
  chat: Chat | null                 // null for a not-yet-created draft
  onRename: (title: string) => void
  sensitive: boolean
  ephemeral: boolean
  expiresAt?: string
  onToggleSensitive: () => void
  onToggleEphemeral: () => void
  caps: ModelCapabilities
  settings: ModelSettings
  onSettingsChange: (s: ModelSettings) => void
  systemPrompt: string
  onSystemPromptChange: (v: string) => void
}

type Tab = 'settings' | 'info'

export default function ChatDetailsDialog({
  open, onClose, isNew, chat, onRename,
  sensitive, ephemeral, expiresAt, onToggleSensitive, onToggleEphemeral,
  caps, settings, onSettingsChange, systemPrompt, onSystemPromptChange,
}: Props) {
  // A draft chat has no title/summary yet, so there's nothing for an Info tab to
  // show — only a saved chat gets the tab bar; a draft just sees Settings directly.
  const [tab, setTab] = useState<Tab>('settings')
  useEffect(() => { if (open) setTab('settings') }, [open])

  const [titleDraft, setTitleDraft] = useState(chat?.title ?? '')
  useEffect(() => { if (open) setTitleDraft(chat?.title ?? '') }, [open, chat?.title])

  const hasInfo = !isNew

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
        </div>
      )}

      {hasInfo && tab === 'info' ? (
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
            <div className="pref-label">Custom instructions for this chat</div>
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
              <label className="setting-label" title="Excluded from memory, summaries and search. Masked in the chat list unless revealed.">
                <FontAwesomeIcon icon={faEyeSlash} />
                <span>Sensitive</span>
              </label>
              <button className={`toggle-btn${sensitive ? ' active' : ''}`} onClick={onToggleSensitive} title="Toggle sensitive">
                {sensitive ? 'On' : 'Off'}
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
          </div>

          <ToolsPanel settings={settings} onChange={onSettingsChange} />
          <ModelTuningPanel caps={caps} settings={settings} onChange={onSettingsChange} />
        </div>
      )}
    </Dialog>
  )
}
