// ── Image generation provider abstraction ─────────────────────────────────────
//
// Bedrock has no frontier image model as of July 2026 (Nova Canvas/Titan Image Generator
// are Legacy, EOL 2026-09-30; no OpenAI/Google image model is offered on Bedrock at all).
// Stability AI's Stable Image family is the Bedrock-native option, so it's the only
// provider wired in today — but the interface below is the seam for adding a direct-API
// provider (OpenAI, Google, Black Forest Labs) later: implement ImageProvider, add one line
// to IMAGE_PROVIDERS. Nothing else in the codebase (tool.ts, bedrock.ts, the frontend)
// needs to change for that.

export interface ImageGenRequest {
  prompt: string
  negativePrompt?: string
  aspectRatio?: string
}

export interface GeneratedImage {
  bytes: Uint8Array
  format: 'png' | 'jpeg'
}

export interface ImageProvider {
  id: string
  name: string
  // Injected into generate_image's tool description — steers how the calling model should
  // author the prompt for this specific provider. Some providers (this one included) take the
  // prompt literally with no server-side expansion; others auto-expand/rewrite short prompts
  // and support conversational follow-up edits. Keeping this per-provider and data-driven means
  // swapping providers changes the guidance the model sees without any dispatch-logic changes.
  promptGuidance: string
  supportsNegativePrompt: boolean
  aspectRatios: string[]
  generate(req: ImageGenRequest): Promise<GeneratedImage>
}

import { bedrockStabilityProvider } from './providers/bedrockStability'

export const IMAGE_PROVIDERS: ImageProvider[] = [bedrockStabilityProvider]

export const DEFAULT_IMAGE_PROVIDER_ID = bedrockStabilityProvider.id

export function getImageProvider(id?: string): ImageProvider {
  return IMAGE_PROVIDERS.find(p => p.id === id) ?? IMAGE_PROVIDERS[0]
}
