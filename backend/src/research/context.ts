import type { RunContext } from './types'
import { getRun, listUserMemories, getProject, listProjectMemories } from '../lib/dynamo'

// A run's prompts are assembled from scratch, not from assembleSystemPrompt — but a research
// question is asked by a person with a country, a job and a set of standing preferences, and a
// planner that can't see any of that spends its clarifying questions re-asking what memory
// already knows. See docs/adr/0033-research-runs-see-the-users-memory.md.

// The block is repeated into every planning call, so it is bounded rather than unbounded — a
// large memory store gets truncated, not sent whole.
export const RUN_CONTEXT_CAP = 4000

interface MemoryRow {
  text?: unknown
  category?: unknown
}

function memoryLines(rows: Record<string, unknown>[]): string[] {
  return rows
    .map(r => (r as MemoryRow).text)
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map(t => `- ${t.trim()}`)
}

/**
 * Snapshots what the run should know about the person who asked, at the moment it starts:
 * their memories, plus the project's instructions and memories when the chat is in one.
 * Returns undefined when there is nothing to say. Snapshotted (rather than re-read per phase)
 * for the same reason the model is — see the ADR.
 */
export async function buildRunContext(sub: string, projectId?: string): Promise<string | undefined> {
  const [userMemories, project, projectMemories] = await Promise.all([
    listUserMemories(sub),
    projectId ? getProject(sub, projectId) : Promise.resolve(undefined),
    projectId ? listProjectMemories(projectId) : Promise.resolve([]),
  ])

  const parts: string[] = []
  const userLines = memoryLines(userMemories as Record<string, unknown>[])
  if (userLines.length > 0) parts.push(`What you know about the user:\n${userLines.join('\n')}`)

  const instructions = project?.instructions
  if (typeof instructions === 'string' && instructions.trim()) {
    parts.push(`Project instructions:\n${instructions.trim()}`)
  }

  const projectLines = memoryLines(projectMemories)
  if (projectLines.length > 0) parts.push(`What you know about this project:\n${projectLines.join('\n')}`)

  if (parts.length === 0) return undefined
  const block = parts.join('\n\n')
  return block.length > RUN_CONTEXT_CAP ? `${block.slice(0, RUN_CONTEXT_CAP)}\n…(truncated)` : block
}

/** Reads the snapshot back off the `RUN#` row, the way resolveRunModel reads the model. */
export async function resolveRunContext(event: RunContext): Promise<string | undefined> {
  const run = await getRun(event.chatId, event.runId)
  const context = run?.context
  return typeof context === 'string' && context.trim() ? context : undefined
}
