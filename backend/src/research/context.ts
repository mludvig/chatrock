import type { RunContext } from './types'
import { getRun, listUserMemories, getProject, listProjectMemories, listProjectFiles } from '../lib/dynamo'
import { fetchS3Text } from '../lib/projectFiles'

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

// Same manifest/forced-file caps ws/sendMessage.ts's assembleSystemPrompt call uses, so a
// run's plan/report see the same amount of project-file material a normal chat turn would.
const FILE_MANIFEST_CAP = 50
const FORCED_FILE_CAP = 20000
const FORCED_FILES_TOTAL_CAP = 80000

/**
 * Snapshots what the run should know about the project's files, at the moment it starts:
 * a navigational manifest (name + micro-label, no content) plus the full text of any
 * inclusion:'always' file. Returns undefined for a chat with no project or no files.
 * Read-only and manifest/forced-only — no read_project_file tool loop for plan/report in
 * this pass. See docs/adr/0038-research-runs-see-project-files.md.
 */
export async function buildRunProjectContext(projectId?: string): Promise<string | undefined> {
  if (!projectId) return undefined
  const files = (await listProjectFiles(projectId)) as Record<string, unknown>[]
  const parts: string[] = []

  const manifestFiles = files
    .filter(f => f.status === 'ready' && f.inclusion !== 'never')
    .slice(0, FILE_MANIFEST_CAP)
    .map(f => `- [${f.fileId}] ${f.filename}${f.microLabel ? ` — ${f.microLabel}` : ''}`)
  if (manifestFiles.length > 0) {
    parts.push(`Project files (labels only — content not loaded unless force-included below):\n${manifestFiles.join('\n')}`)
  }

  const alwaysFiles = files.filter(f => f.status === 'ready' && f.inclusion === 'always')
  if (alwaysFiles.length > 0) {
    const blocks: string[] = []
    let totalChars = 0
    for (const f of alwaysFiles) {
      const contentType = f.contentType as string
      const isTextLike = contentType.startsWith('text/') || contentType === 'application/octet-stream'
      const keyToRead = (f.extractedTextKey ?? f.s3Key) as string
      if (!(isTextLike || (contentType === 'application/pdf' && f.extractedTextKey))) continue
      try {
        const raw = await fetchS3Text(keyToRead)
        if (totalChars + raw.length > FORCED_FILES_TOTAL_CAP) break
        const capped = raw.length > FORCED_FILE_CAP ? `${raw.slice(0, FORCED_FILE_CAP)}\n\n[... truncated ...]` : raw
        blocks.push(`--- ${f.filename} ---\n${capped}`)
        totalChars += raw.length
      } catch { /* skip unreadable file */ }
    }
    if (blocks.length > 0) parts.push(`Always-included project files (full content):\n\n${blocks.join('\n\n')}`)
  }

  return parts.length > 0 ? parts.join('\n\n') : undefined
}

/** Reads the project-file snapshot back off the `RUN#` row. */
export async function resolveRunProjectContext(event: RunContext): Promise<string | undefined> {
  const run = await getRun(event.chatId, event.runId)
  const projectContext = run?.projectContext
  return typeof projectContext === 'string' && projectContext.trim() ? projectContext : undefined
}
