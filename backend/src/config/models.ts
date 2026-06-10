// ── Model capabilities ────────────────────────────────────────────────────────

export interface ModelCapabilities {
  temperature: boolean
  topP: boolean
  topK: boolean
  // 'adaptive' = effort-based (low/medium/high/max); 'none' = no thinking support
  thinking: 'adaptive' | 'none'
}

// Per-send inference settings from the client. Only include supported fields.
export interface ModelSettings {
  temperature?: number                              // 0.0–1.0
  topP?: number                                     // 0.0–1.0
  topK?: number                                     // 1–500 (integer)
  thinkingEffort?: 'off' | 'low' | 'medium' | 'high' | 'max'
}

// ── Model registry ────────────────────────────────────────────────────────────

export interface Model {
  id: string
  name: string
  capabilities: ModelCapabilities
}

// Global cross-region inference profiles — available in ap-southeast-2
// Verified via: aws bedrock list-inference-profiles --region ap-southeast-2 --type-equals SYSTEM_DEFINED
export const MODELS: Model[] = [
  {
    id: 'global.anthropic.claude-opus-4-8',
    name: 'Claude Opus 4.8',
    capabilities: { temperature: true, topP: true, topK: true, thinking: 'adaptive' },
  },
  {
    id: 'global.anthropic.claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    capabilities: { temperature: true, topP: true, topK: true, thinking: 'adaptive' },
  },
  {
    id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    name: 'Claude Haiku 4.5',
    capabilities: { temperature: true, topP: true, topK: true, thinking: 'none' },
  },
]

export const DEFAULT_CHAT_MODEL = 'global.anthropic.claude-sonnet-4-6'

// Cheaper model used for auto-title generation only
export const TITLE_MODEL = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'

// ── Capability helpers ────────────────────────────────────────────────────────

export function getCapabilities(modelId: string): ModelCapabilities {
  return MODELS.find(m => m.id === modelId)?.capabilities
    ?? { temperature: true, topP: true, topK: false, thinking: 'none' }
}

export function isValidModelId(modelId: string): boolean {
  return MODELS.some(m => m.id === modelId)
}

export function defaultSettings(caps: ModelCapabilities): ModelSettings {
  return {
    ...(caps.thinking !== 'none' ? { thinkingEffort: 'off' as const } : {}),
  }
}
