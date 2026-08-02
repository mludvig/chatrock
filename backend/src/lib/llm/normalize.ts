import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime'
import { type Block, isNeutralBlocks } from './blocks'
import { toNeutral } from './providers/converseTranslate'

/**
 * Upgrade a row's stored `blocks` to the neutral format on read. A legacy row
 * (written before the provider-neutral cutover) is, by definition, in the raw
 * Bedrock Converse ContentBlock[] shape — exactly what `toNeutral` already
 * parses for every fresh Anthropic turn — so this is a near-free compatibility
 * shim, not a second code path.
 *
 * TEMPORARY: remove this call (and this file) once `scripts/migrate-blocks.mjs`
 * has run against prod and no pre-cutover rows remain. Tracked as the final task
 * of the migration step.
 */
export function normalizeStoredBlocks(blocks: unknown[]): Block[] {
  if (isNeutralBlocks(blocks)) return blocks
  return toNeutral(blocks as ContentBlock[])
}
