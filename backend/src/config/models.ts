export interface Model {
  id: string
  name: string
}

// Global cross-region inference profiles — available in ap-southeast-2
// Verified via: aws bedrock list-inference-profiles --region ap-southeast-2 --type-equals SYSTEM_DEFINED
export const MODELS: Model[] = [
  { id: 'global.anthropic.claude-opus-4-8',             name: 'Claude Opus 4.8' },
  { id: 'global.anthropic.claude-sonnet-4-6',           name: 'Claude Sonnet 4.6' },
  { id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', name: 'Claude Haiku 4.5' },
]

export const DEFAULT_CHAT_MODEL = 'global.anthropic.claude-sonnet-4-6'

// Cheaper model used for auto-title generation only
export const TITLE_MODEL = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'
