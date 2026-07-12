import { useEffect, useState } from 'react'
import type { Chat, ModelCapabilities, ModelSettings } from '../api/http'
import Dialog from './Dialog'
import ModelSettingsPanel from './ModelSettingsPanel'
import { ToggleRow, EffortRow } from './PrefControls'

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

export default function ChatDetailsDialog({
  open, onClose, isNew, chat, onRename,
  sensitive, ephemeral, expiresAt, onToggleSensitive, onToggleEphemeral,
  caps, settings, onSettingsChange, systemPrompt, onSystemPromptChange,
}: Props) {
  const [titleDraft, setTitleDraft] = useState(chat?.title ?? '')
  useEffect(() => { if (open) setTitleDraft(chat?.title ?? '') }, [open, chat?.title])

  return (
    <Dialog open={open} onClose={onClose} title="Chat details">
      <div className="prefs-tab-content">
        {!isNew && (
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
        )}

        {!isNew && (chat?.summary || (chat?.topics && chat.topics.length > 0)) && (
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

        <div className="pref-label" style={{ marginTop: 4 }}>Privacy</div>
        <ToggleRow
          label="Sensitive"
          hint="Excluded from memory, summaries and search. Masked in the chat list unless revealed."
          on={sensitive}
          onToggle={onToggleSensitive}
        />
        <ToggleRow
          label="Auto-delete"
          hint={ephemeral && expiresAt ? `Expires ${new Date(expiresAt).toLocaleString()}.` : 'Deletes itself after a TTL.'}
          on={ephemeral}
          onToggle={onToggleEphemeral}
        />

        <div className="pref-section">
          <div className="pref-label">Custom instructions for this chat</div>
          <textarea
            className="pref-textarea"
            placeholder="Override global instructions for this chat only…"
            value={systemPrompt}
            onChange={e => onSystemPromptChange(e.target.value)}
          />
        </div>

        <ModelSettingsPanel caps={caps} settings={settings} onChange={onSettingsChange} />

        <EffortRow
          label="Answer length"
          options={['default', 'short', 'extensive'] as const}
          value={settings.answerLength ?? 'default'}
          onChange={v => onSettingsChange({ ...settings, answerLength: v })}
        />

        <ToggleRow
          label="Inject current timestamp"
          on={settings.injectCurrentDate !== false}
          onToggle={() => onSettingsChange({ ...settings, injectCurrentDate: settings.injectCurrentDate === false ? true : false })}
        />
      </div>
    </Dialog>
  )
}
