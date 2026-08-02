// ── Model capabilities ────────────────────────────────────────────────────────

import type { ProviderId } from '../lib/llm/blocks'

export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high' | 'max'

export interface ModelCapabilities {
  provider: ProviderId
  temperature: boolean
  topP: boolean
  topK: boolean
  // 'adaptive' = Bedrock Converse's thinking.type=adaptive + output_config.effort (Anthropic);
  // 'effort' = a plain reasoning.effort dial (e.g. Bedrock Mantle/OpenAI); 'none' = unsupported.
  thinking: 'adaptive' | 'effort' | 'none'
  // Which of ThinkingEffort's five levels this model accepts. Omit -> all five.
  thinkingLevels?: ThinkingEffort[]
  attachments: boolean                           // images
  documents: boolean                             // pdf/txt/csv/md
  promptCaching: 'auto' | 'explicit' | 'none'
  region?: string                                // per-model region pin; undefined -> bedrockRegion()
  maxOutputTokens?: number
}

// Per-send inference settings from the client. Only include supported fields.
export interface ModelSettings {
  temperature?: number                              // 0.0–1.0
  topP?: number                                     // 0.0–1.0
  topK?: number                                     // 1–500 (integer)
  thinkingEffort?: ThinkingEffort
  webSearchEnabled?: boolean                        // false disables web tools
  webSearchProvider?: 'jina' | 'agentcore'           // which backend powers the web_search tool
  browserCoreEnabled?: boolean                      // false disables take_screenshot/get_rendered_page
  browserExtendedEnabled?: boolean                  // true enables the scripted browse_web tool
  memoryEnabled?: boolean                           // false skips injection + extraction
  searchEnabled?: boolean                           // false omits the search_history tool from organic tool choice
  imageGenerationEnabled?: boolean                  // true enables the generate_image tool (opt-in — costs money per call)
  answerLength?: 'default' | 'short' | 'extensive' // per-chat answer-length override
  injectCurrentDate?: boolean                       // true = prepend timestamp block to user turns
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
    id: 'global.anthropic.claude-fable-5',
    name: 'Claude Fable 5',
    capabilities: { provider: 'bedrock-converse', temperature: false, topP: false, topK: false, thinking: 'adaptive', attachments: true, documents: true, promptCaching: 'explicit', maxOutputTokens: 16000 },
  },
  {
    id: 'global.anthropic.claude-opus-5',
    name: 'Claude Opus 5',
    capabilities: { provider: 'bedrock-converse', temperature: false, topP: false, topK: false, thinking: 'adaptive', attachments: true, documents: true, promptCaching: 'explicit', maxOutputTokens: 16000 },
  },
  {
    id: 'global.anthropic.claude-sonnet-5',
    name: 'Claude Sonnet 5',
    capabilities: { provider: 'bedrock-converse', temperature: true, topP: true, topK: false, thinking: 'adaptive', attachments: true, documents: true, promptCaching: 'explicit', maxOutputTokens: 16000 },
  },
  {
    id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    name: 'Claude Haiku 4.5',
    capabilities: { provider: 'bedrock-converse', temperature: true, topP: true, topK: true, thinking: 'none', attachments: true, documents: true, promptCaching: 'explicit', maxOutputTokens: 16000 },
  },
  // Bedrock Mantle (OpenAI Responses API) — no cross-region inference profile, no
  // ap-southeast-2 availability as of Aug 2026: pinned to us-east-1 (see backend/CLAUDE.md's
  // "LLM providers" section). Always reasons (no 'off' level) — thinkingLevels omits it.
  {
    id: 'openai.gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    capabilities: {
      provider: 'bedrock-mantle', temperature: false, topP: false, topK: false,
      thinking: 'effort', thinkingLevels: ['low', 'medium', 'high', 'max'],
      attachments: true, documents: true, promptCaching: 'explicit',
      region: 'us-east-1', maxOutputTokens: 16000,
    },
  },
]

export const DEFAULT_CHAT_MODEL = 'global.anthropic.claude-sonnet-5'

// Cheaper model used for auto-title generation only
export const TITLE_MODEL = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'

// Model used for background memory extraction after each turn.
export const MEMORY_EXTRACTION_MODEL = DEFAULT_CHAT_MODEL

// ── Capability helpers ────────────────────────────────────────────────────────

export function getCapabilities(modelId: string): ModelCapabilities {
  return MODELS.find(m => m.id === modelId)?.capabilities
    ?? { provider: 'bedrock-converse', temperature: true, topP: true, topK: false, thinking: 'none', attachments: true, documents: true, promptCaching: 'none' }
}

export function isValidModelId(modelId: string): boolean {
  return MODELS.some(m => m.id === modelId)
}

export function defaultSettings(caps: ModelCapabilities): ModelSettings {
  const defaultEffort: ThinkingEffort = caps.thinkingLevels?.includes('low') === false
    ? (caps.thinkingLevels[0] ?? 'low')
    : 'low'
  return {
    ...(caps.thinking !== 'none' ? { thinkingEffort: defaultEffort } : {}),
  }
}
