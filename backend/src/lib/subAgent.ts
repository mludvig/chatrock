import { converseStream } from './llm/loop'
import { capToolResultText } from './llm/blocks'
import type { ToolContext } from './tools'
import type { ToolResult } from './llm/toolSpec'
import type { ModelSettings } from '../config/models'
import { DEFAULT_CHAT_MODEL } from '../config/models'
import RESEARCH_TASK_SYSTEM_PROMPT from '../../prompts/research-task.txt'

// A researcher sub-agent has no chat/memory/project context to draw on, just its one
// sub-question, so every other tool is switched off. Same settings the old Step
// Functions researcher.ts used. See docs/adr/0039-deep-research-as-a-sub-agent-tool.md.
const RESEARCHER_SETTINGS: ModelSettings = {
  researchDepth: 'extended',
  webSearchEnabled: true,
  browserCoreEnabled: false,
  browserExtendedEnabled: false,
  memoryEnabled: false,
  searchEnabled: false,
  imageGenerationEnabled: false,
}

// Cap on the text handed back to the orchestrator for one sub-question — generous for a
// thorough ~900-word answer with citations while staying well clear of the per-tool-result
// share of TOOL_RESULTS_ROUND_CAP when several researchers land in the same round.
export const RESEARCH_FINDING_CAP = 8_000

// The run_research_task tool executor (dispatched lazily from tools.ts to avoid a
// tools.ts -> subAgent -> loop.ts -> tools.ts import cycle). One bounded converseStream
// over a single self-contained sub-question, using the same tool-loop machinery
// ws/sendMessage.ts uses, narrating progress back to the parent turn via ctx.onProgress.
// See docs/adr/0039-deep-research-as-a-sub-agent-tool.md.
export async function runResearchTask(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const question = typeof input.question === 'string' ? input.question.trim() : ''
  if (!question) {
    return { entries: [{ kind: 'text', text: 'Error: question is required and must be a non-empty string.' }], isError: true }
  }

  const subCtx: ToolContext = { ...ctx, subAgentDepth: (ctx.subAgentDepth ?? 0) + 1 }

  try {
    let finalText = ''
    for await (const chunk of converseStream(
      ctx.modelId ?? DEFAULT_CHAT_MODEL,
      RESEARCH_TASK_SYSTEM_PROMPT,
      [{ role: 'user', content: [{ kind: 'text', text: question }] }],
      {
        settings: RESEARCHER_SETTINGS,
        ctx: subCtx,
        deadlineAt: ctx.deadlineAt,
        call: { purpose: 'research_task', sub: ctx.sub, chatId: ctx.chatId },
      },
    )) {
      if (chunk.type === 'tool_call' && ctx.onProgress) {
        ctx.onProgress(`Searching: ${describeToolInput(chunk.name, chunk.input)}`)
      } else if (chunk.type === 'turn' && chunk.role === 'assistant') {
        finalText = chunk.content.filter(b => b.kind === 'text').map(b => b.text).join('\n')
      }
    }

    if (!finalText.trim()) {
      return { entries: [{ kind: 'text', text: 'The researcher finished without producing an answer.' }], isError: true }
    }
    return { entries: [{ kind: 'text', text: capToolResultText(finalText, RESEARCH_FINDING_CAP) }], isError: false }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { entries: [{ kind: 'text', text: `Research task failed: ${message}` }], isError: true }
  }
}

// Best-effort one-line narration for a tool_call chunk — used only for the live progress
// pill, never persisted, so it doesn't need to be exhaustive over every tool's input shape.
function describeToolInput(name: string, inputJson: string): string {
  try {
    const parsed = JSON.parse(inputJson) as Record<string, unknown>
    const detail = typeof parsed.query === 'string' ? parsed.query : typeof parsed.url === 'string' ? parsed.url : ''
    return detail ? `${name} "${detail}"` : name
  } catch {
    return name
  }
}
