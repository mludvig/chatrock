import type { RunContext } from './types'
import { getRun } from '../lib/dynamo'
import { DEFAULT_CHAT_MODEL, isValidModelId } from '../config/models'

// Every LLM call in a run uses the chat's own model, snapshotted onto the RUN# row at
// startResearch. See docs/adr/0030-research-runs-use-the-chats-model.md for why the model
// is read back from the row here rather than threaded through the Step Functions state.
export async function resolveRunModel(event: RunContext): Promise<string> {
  const run = await getRun(event.chatId, event.runId)
  const model = run?.model
  if (typeof model === 'string' && isValidModelId(model)) return model
  // No model on the row (a run started before this field existed) or one that has since
  // been retired from the registry — the same fallback http/chats.ts's resolveChatModel
  // applies to a stale chat model.
  return DEFAULT_CHAT_MODEL
}
