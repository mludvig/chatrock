// ── ChatProvider registry ────────────────────────────────────────────────────
//
// The seam a future non-AWS provider (e.g. Gemini direct) plugs into: implement
// ChatProvider, add one line to CHAT_PROVIDERS. loop.ts, blocks.ts, toolGating.ts,
// tools.ts, transcript.ts and tree.ts contain no provider-specific reasoning —
// getProvider(modelId) is the only place that dispatches.
import type { ChatProvider } from './types'
import { getCapabilities } from '../../config/models'
import { bedrockConverseProvider } from './providers/bedrockConverse'

export const CHAT_PROVIDERS: ChatProvider[] = [bedrockConverseProvider]

export function getProvider(modelId: string): ChatProvider {
  const providerId = getCapabilities(modelId).provider
  const provider = CHAT_PROVIDERS.find(p => p.id === providerId)
  if (!provider) throw new Error(`No ChatProvider registered for provider id '${providerId}' (model '${modelId}')`)
  return provider
}
