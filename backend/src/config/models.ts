export interface Model {
  id: string
  name: string
}

export const MODELS: Model[] = [
  { id: 'apac.anthropic.claude-opus-4-8',          name: 'Claude Opus 4.8' },
  { id: 'apac.anthropic.claude-sonnet-4-6',         name: 'Claude Sonnet 4.6' },
  { id: 'apac.anthropic.claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
]

export const DEFAULT_CHAT_MODEL = 'apac.anthropic.claude-sonnet-4-6'

// Cheaper model used for auto-title generation only
export const TITLE_MODEL = 'apac.anthropic.claude-haiku-4-5-20251001'
