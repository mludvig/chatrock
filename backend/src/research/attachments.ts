import type { RunContext } from './types'
import { getRun } from '../lib/dynamo'
import { attachmentBlock, hydrateBlocks, type AttachmentMeta } from '../lib/attachments'
import type { Block } from '../lib/llm/blocks'

// Reads the question's attachment refs back off the RUN# row and hydrates them into
// ready-to-send Block[] — mirrors resolveRunModel/resolveRunContext. Hydration happens here
// so no phase can forget it (converseOnce does not hydrate on its own). See
// docs/adr/0034-research-runs-carry-the-questions-attachments.md.
export async function resolveRunAttachmentBlocks(event: RunContext): Promise<Block[]> {
  const run = await getRun(event.chatId, event.runId)
  const attachments = run?.attachments as AttachmentMeta[] | undefined
  if (!attachments || attachments.length === 0) return []
  return hydrateBlocks(attachments.map(a => attachmentBlock(a)))
}
