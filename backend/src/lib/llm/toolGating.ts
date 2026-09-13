// Provider-agnostic tool-list gating: which tools are offered this turn, based on
// ModelSettings + ToolContext. Returns the neutral ToolSpec[] — each provider
// adapter is responsible for lowering it to its own wire format (see
// providers/bedrockConverse.ts's toBedrockToolsWithCache).
import {
  WEB_TOOLS, MEMORY_TOOL, MANAGE_PROJECT_MEMORY_TOOL, READ_PROJECT_FILE_TOOL, READ_PROJECT_CHAT_TOOL,
  BROWSER_TOOL, TAKE_SCREENSHOT_TOOL, GET_RENDERED_PAGE_TOOL, SEARCH_HISTORY_TOOL, GENERATE_IMAGE_TOOL,
  RUN_RESEARCH_TASK_TOOL,
  type ToolContext,
} from '../tools'
import type { ToolSpec } from './toolSpec'
import type { ModelSettings } from '../../config/models'

export function buildToolList(settings: ModelSettings, ctx?: ToolContext): ToolSpec[] {
  const list: ToolSpec[] = []
  if (settings.webSearchEnabled !== false) list.push(...WEB_TOOLS)
  if (settings.browserCoreEnabled !== false) list.push(TAKE_SCREENSHOT_TOOL, GET_RENDERED_PAGE_TOOL)
  if (settings.browserExtendedEnabled === true) list.push(BROWSER_TOOL)
  if (settings.memoryEnabled !== false && !ctx?.sensitive) list.push(MEMORY_TOOL)
  if (ctx?.projectId && settings.memoryEnabled !== false && ctx.projectMemoryEnabled !== false && !ctx.sensitive) list.push(MANAGE_PROJECT_MEMORY_TOOL)
  if (ctx?.projectId) list.push(READ_PROJECT_FILE_TOOL, READ_PROJECT_CHAT_TOOL)
  // ctx.searchScope is set only for a forced/explicit Search turn (ws/sendMessage.ts) — force
  // the tool into the list even if searchEnabled:false, since a forced toolChoice requires the
  // named tool to be present in the offered tool list.
  if (settings.searchEnabled !== false || ctx?.searchScope) list.push(SEARCH_HISTORY_TOOL)
  if (settings.imageGenerationEnabled === true) list.push(GENERATE_IMAGE_TOOL)
  // Only a top-level deep turn gets the sub-agent tool — subAgentDepth is set on the
  // ToolContext a researcher's own converseStream call runs under, so a researcher can never
  // spawn researchers. See docs/adr/0039-deep-research-as-a-sub-agent-tool.md.
  if (settings.researchDepth === 'deep' && !ctx?.subAgentDepth) list.push(RUN_RESEARCH_TASK_TOOL)
  return list
}

// The minimal default set re-offered by a provider that requires a non-empty tool
// list whenever tool_call/tool_result blocks appear in history (Bedrock Converse's
// toolConfig constraint) — used only when the gated list above came back empty.
export function buildDefaultToolList(): ToolSpec[] {
  return [...WEB_TOOLS, MEMORY_TOOL]
}
