// ── Model capabilities ────────────────────────────────────────────────────────

import type { ProviderId } from '../lib/llm/blocks'

export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high' | 'max'

export interface ModelCapabilities {
  provider: ProviderId
  // 'adaptive' = Bedrock Converse's thinking.type=adaptive + output_config.effort (Anthropic);
  // 'effort' = a plain reasoning.effort dial (e.g. OpenAI via Bedrock Responses); 'none' = unsupported.
  thinking: 'adaptive' | 'effort' | 'none'
  // Which of ThinkingEffort's five levels this model accepts. Omit -> all five.
  thinkingLevels?: ThinkingEffort[]
  attachments: boolean                           // images
  documents: boolean                             // pdf/txt/csv/md
  promptCaching: 'auto' | 'explicit' | 'none'
  maxOutputTokens?: number
}

// Per-send inference settings from the client. Only include supported fields.
export interface ModelSettings {
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
  // Agentic tool-round budget for this turn. Absent -> 'brief'. See docs/adr/0020-research-depth-and-budget-pacing.md.
  researchDepth?: 'brief' | 'extended' | 'deep'
}

// ── Model registry ────────────────────────────────────────────────────────────

export interface Model {
  id: string
  name: string
  // Retired model ids this model takes over — a chat stored with one of them continues on this
  // model. When this model is itself retired, move its id and this whole list to its successor.
  replaces?: string[]
  capabilities: ModelCapabilities
}

// Global cross-region inference profiles — available in ap-southeast-2
// Verified via: aws bedrock list-inference-profiles --region ap-southeast-2 --type-equals SYSTEM_DEFINED
export const MODELS: Model[] = [
  {
    id: 'global.anthropic.claude-fable-5-1',
    name: 'Claude Fable 5.1',
    replaces: ['global.anthropic.claude-fable-5'],
    capabilities: { provider: 'bedrock-converse', thinking: 'adaptive', attachments: true, documents: true, promptCaching: 'explicit', maxOutputTokens: 16000 },
  },
  {
    id: 'global.anthropic.claude-opus-5-5',
    name: 'Claude Opus 5.5',
    replaces: [
      'global.anthropic.claude-opus-5', 'global.anthropic.claude-opus-5-1',
      'global.anthropic.claude-opus-4-8', 'apac.anthropic.claude-opus-4-8',
    ],
    capabilities: { provider: 'bedrock-converse', thinking: 'adaptive', attachments: true, documents: true, promptCaching: 'explicit', maxOutputTokens: 16000 },
  },
  {
    id: 'global.anthropic.claude-sonnet-5',
    name: 'Claude Sonnet 5',
    replaces: ['global.anthropic.claude-sonnet-4-6', 'apac.anthropic.claude-sonnet-4-6'],
    capabilities: { provider: 'bedrock-converse', thinking: 'adaptive', attachments: true, documents: true, promptCaching: 'explicit', maxOutputTokens: 16000 },
  },
  {
    id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    name: 'Claude Haiku 4.5',
    replaces: ['apac.anthropic.claude-haiku-4-5-20251001'],
    capabilities: { provider: 'bedrock-converse', thinking: 'none', attachments: true, documents: true, promptCaching: 'explicit', maxOutputTokens: 16000 },
  },
  // OpenAI GPT via the Responses API on bedrock-runtime (docs/adr/0048-openai-models-on-bedrock-runtime.md).
  // Always reasons (no 'off' level) — thinkingLevels omits it.
  {
    id: 'global.openai.gpt-6-astra',
    name: 'GPT-6 Astra',
    replaces: ['openai.gpt-6-astra'],
    capabilities: {
      provider: 'bedrock-responses',
      thinking: 'effort', thinkingLevels: ['low', 'medium', 'high', 'max'],
      attachments: true, documents: true, promptCaching: 'explicit',
      maxOutputTokens: 16000,
    },
  },
  {
    id: 'global.openai.gpt-6-sol',
    name: 'GPT-6 Sol',
    replaces: ['global.openai.gpt-5.6-sol', 'openai.gpt-5.6-sol'],
    capabilities: {
      provider: 'bedrock-responses',
      thinking: 'effort', thinkingLevels: ['low', 'medium', 'high', 'max'],
      attachments: true, documents: true, promptCaching: 'explicit',
      maxOutputTokens: 16000,
    },
  },
  {
    id: 'global.openai.gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    replaces: ['openai.gpt-5.6-terra'],
    capabilities: {
      provider: 'bedrock-responses',
      thinking: 'effort', thinkingLevels: ['low', 'medium', 'high', 'max'],
      attachments: true, documents: true, promptCaching: 'explicit',
      maxOutputTokens: 16000,
    },
  },
  {
    id: 'global.openai.gpt-6-luna',
    name: 'GPT-6 Luna',
    replaces: ['global.openai.gpt-5.6-luna', 'openai.gpt-5.6-luna'],
    capabilities: {
      provider: 'bedrock-responses',
      thinking: 'effort', thinkingLevels: ['low', 'medium', 'high', 'max'],
      attachments: true, documents: true, promptCaching: 'explicit',
      maxOutputTokens: 16000,
    },
  },
  // Moonshot Kimi K3 via the Responses API (docs/adr/0051-kimi-k3-on-the-responses-api.md).
  // Verified live against ap-southeast-2 Sep 2026: effort accepts none|low|medium|high|xhigh|max
  // ('off' is sent as 'none'); reasoning streams as reasoning_text, with no encrypted_content;
  // images, PDF input_file, tools, forced tool_choice and automatic prompt caching all work.
  {
    id: 'global.moonshotai.kimi-k3',
    name: 'Kimi K3',
    capabilities: {
      provider: 'bedrock-responses', thinking: 'effort',
      attachments: true, documents: true, promptCaching: 'explicit',
      maxOutputTokens: 16000,
    },
  },
  // xAI Grok 4.6 via Bedrock Converse. Verified live against ap-southeast-2 Aug 2026:
  // rejects temperature/topP (ValidationException), rejects document blocks outright,
  // and image blocks 500/503 despite the model card listing IMAGE input — not usable yet.
  // Always emits a reasoningContent/redactedContent block regardless of any thinking
  // param tried (Anthropic-style thinking.type=adaptive, a plain reasoning_effort) with
  // no observable effect on output — no confirmed effort dial, so thinking is 'none'.
  {
    id: 'global.xai.grok-4.6',
    name: 'Grok 4.6',
    capabilities: { provider: 'bedrock-converse', thinking: 'none', attachments: false, documents: false, promptCaching: 'none', maxOutputTokens: 16000 },
  },
]

export const DEFAULT_CHAT_MODEL = 'global.anthropic.claude-sonnet-5'

// The smallest/cheapest model, for short mechanical calls whose output is a title or a
// one-word classification rather than anything the user reads as an answer.
export const TINY_MODEL = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'

// Cheaper model used for auto-title generation only
export const TITLE_MODEL = TINY_MODEL

// Model used for background memory extraction after each turn.
export const MEMORY_EXTRACTION_MODEL = DEFAULT_CHAT_MODEL

// ── Capability helpers ────────────────────────────────────────────────────────

export function getCapabilities(modelId: string): ModelCapabilities {
  return MODELS.find(m => m.id === modelId)?.capabilities
    ?? { provider: 'bedrock-converse', thinking: 'none', attachments: true, documents: true, promptCaching: 'none' }
}

export function isValidModelId(modelId: string): boolean {
  return MODELS.some(m => m.id === modelId)
}

// A stored model id -> the live model to use for it: unchanged if live, else the model whose
// `replaces` lists it, else undefined. See docs/adr/0050-retired-models-hand-off-to-a-successor.md.
export function currentModelId(modelId: string): string | undefined {
  if (isValidModelId(modelId)) return modelId
  return MODELS.find(m => m.replaces?.includes(modelId))?.id
}

// currentModelId with DEFAULT_CHAT_MODEL as the last resort, for a chat that must have a model.
// `migratedFrom` is set whenever the id changed.
export function resolveModelId(modelId: string): { model: string; migratedFrom?: string } {
  if (isValidModelId(modelId)) return { model: modelId }
  return { model: currentModelId(modelId) ?? DEFAULT_CHAT_MODEL, migratedFrom: modelId }
}

export function defaultSettings(caps: ModelCapabilities): ModelSettings {
  const defaultEffort: ThinkingEffort = caps.thinkingLevels?.includes('low') === false
    ? (caps.thinkingLevels[0] ?? 'low')
    : 'low'
  return {
    ...(caps.thinking !== 'none' ? { thinkingEffort: defaultEffort } : {}),
  }
}
