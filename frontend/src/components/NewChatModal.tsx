import { useState } from 'react'
import type { Model } from '../api/http'

interface Props {
  models: Model[]
  defaultModel: string
  onConfirm: (model: string, systemPrompt: string) => void
  onCancel: () => void
}

export default function NewChatModal({ models, defaultModel, onConfirm, onCancel }: Props) {
  const [model, setModel] = useState(defaultModel)
  const [systemPrompt, setSystemPrompt] = useState('')

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>New Chat</h2>
        <label>
          Model
          <select value={model} onChange={e => setModel(e.target.value)}>
            {models.map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
        <label>
          System prompt <span className="hint">(optional)</span>
          <textarea
            rows={4}
            placeholder="You are a helpful assistant…"
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn-primary" onClick={() => onConfirm(model, systemPrompt)}>Start</button>
        </div>
      </div>
    </div>
  )
}
