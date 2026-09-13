import type { ToolResult } from './llm/toolSpec'
import { converseOnce } from './bedrock'
import { MEMORY_EXTRACTION_MODEL } from '../config/models'
import { safeParse } from './enrichment'
import { listChats, listProjectFiles, listProjects } from './dynamo'
import SEARCH_HISTORY_SYSTEM_PROMPT from '../../prompts/search-history-ranker.txt'

// ── Types ────────────────────────────────────────────────────────────────────

export interface SearchHistoryCorpusItem {
  kind: 'chat' | 'file'
  id: string                 // chatId or fileId
  title: string              // chat title or filename
  topics?: string[]          // chats only
  summary: string            // chat summary, or file summary/microLabel
  projectId?: string         // link target: file's project, or chat's project
}

export interface SearchHistoryResult {
  kind: 'chat' | 'file'
  id: string
  title: string
  reason: string
  projectId?: string
}

// Bound the corpus handed to the model — same purpose as sendMessage.ts's manifest caps
// (FILE_MANIFEST_CAP/CHAT_MANIFEST_CAP). Corpus is assumed pre-ordered most-recent-first
// (ULID desc / sortByRecent), so slicing keeps the most recent items.
export const SEARCH_HISTORY_CORPUS_CAP = 200

function corpusLine(item: SearchHistoryCorpusItem): string {
  const topics = (item.topics ?? []).join(', ')
  const summary = item.summary.slice(0, 300)
  return `[${item.kind}:${item.id}] ${item.title} :: ${topics} :: ${summary}`
}

interface RawSearchHistoryResult {
  id?: unknown
  reason?: unknown
}

/**
 * Haiku call that ranks a corpus of chats/project-file summaries against a free-text query.
 * Never throws — returns [] on any failure (empty corpus, blank query, parse failure, or
 * a Bedrock error), the same defensive shape as enrichUserFacts/summarizeChat.
 */
export async function searchHistory(
  corpus: SearchHistoryCorpusItem[],
  query: string,
  opts?: { chatId?: string; scope?: 'project' | 'global' },
): Promise<SearchHistoryResult[]> {
  if (corpus.length === 0) return []
  if (!query.trim()) return []

  const kept = corpus.length > SEARCH_HISTORY_CORPUS_CAP ? corpus.slice(0, SEARCH_HISTORY_CORPUS_CAP) : corpus
  if (kept.length < corpus.length) {
    console.log(JSON.stringify({
      event: 'search_history_truncated', total: corpus.length, kept: kept.length, scope: opts?.scope, chatId: opts?.chatId,
    }))
  }

  try {
    const byToken = new Map(kept.map(item => [`${item.kind}:${item.id}`, item]))
    const userMsg = [
      `QUERY: ${query}`,
      ``,
      `CORPUS:`,
      kept.map(corpusLine).join('\n'),
    ].join('\n')

    const response = await converseOnce(
      MEMORY_EXTRACTION_MODEL,
      SEARCH_HISTORY_SYSTEM_PROMPT,
      [{ role: 'user', content: [{ kind: 'text', text: userMsg }] }],
      { maxTokens: 1024, call: { purpose: 'search_history', chatId: opts?.chatId } },
    )

    const obj = safeParse(response)
    if (!obj) {
      console.error(JSON.stringify({ event: 'search_history_parse_error', chatId: opts?.chatId, response: response?.slice(0, 500) }))
      return []
    }

    const rawResults = Array.isArray(obj.results) ? (obj.results as RawSearchHistoryResult[]) : []
    const results: SearchHistoryResult[] = []
    for (const r of rawResults) {
      if (typeof r.id !== 'string') continue
      const item = byToken.get(r.id)
      if (!item) continue // drop hallucinated ids not present in the corpus
      results.push({
        kind: item.kind,
        id: item.id,
        title: item.title,
        reason: typeof r.reason === 'string' ? r.reason.trim().slice(0, 300) : '',
        ...(item.projectId !== undefined ? { projectId: item.projectId } : {}),
      })
    }
    return results
  } catch (err) {
    console.error(JSON.stringify({ event: 'search_history_error', chatId: opts?.chatId, error: String(err) }))
    return []
  }
}

// ── search_history tool executor ──────────────────────────────────────────────
//
// Co-located with searchHistory() (rather than tools.ts/projectContext.ts) since this is the
// "retrieval seam" the north-star context-assembly layer grows from — ranking and corpus
// assembly belong together. The Tool *spec* (name/description/inputSchema) lives in tools.ts,
// matching the existing split (e.g. MEMORY_TOOL spec in tools.ts, executeMemoryTool in memory.ts).

// Cross-project file sweep for global scope is capped — same purpose as SEARCH_HISTORY_CORPUS_CAP,
// just bounding the number of listProjectFiles calls rather than the corpus size itself.
const SEARCH_HISTORY_PROJECT_SWEEP_CAP = 20

export interface SearchHistoryContext {
  sub: string
  projectId?: string
  chatId?: string
  // Set only for a forced/explicit Search turn (see ws/sendMessage.ts) — when present, this is
  // authoritative and model-supplied `input.scope` is ignored. Organic mid-conversation calls
  // leave this undefined and the model's own `scope` choice (still bounded: 'project' always
  // resolves to ctx.projectId, never a model-supplied project id) is used instead.
  searchScope?: 'project' | 'global'
}

function chatIdFromRow(row: Record<string, unknown>): string {
  return (row.SK as string).replace('CHAT#', '')
}

function projectIdFromRow(row: Record<string, unknown>): string {
  return (row.SK as string).replace('PROJECT#', '')
}

async function chatCorpusItems(sub: string, filterProjectId?: string): Promise<SearchHistoryCorpusItem[]> {
  const rows = await listChats(sub)
  return rows
    .filter(r => r.sensitive !== true) // never surfaced via search_history from another chat
    .filter(r => (filterProjectId ? r.projectId === filterProjectId : true))
    .filter(r => typeof r.summary === 'string' && (r.summary as string).trim().length > 0)
    .map(r => ({
      kind: 'chat' as const,
      id: chatIdFromRow(r),
      title: typeof r.title === 'string' ? r.title : 'Untitled chat',
      topics: Array.isArray(r.topics) ? (r.topics as string[]) : undefined,
      summary: r.summary as string,
      ...(typeof r.projectId === 'string' ? { projectId: r.projectId } : {}),
    }))
}

async function fileCorpusItemsForProject(projectId: string): Promise<SearchHistoryCorpusItem[]> {
  const rows = await listProjectFiles(projectId)
  return rows
    .filter(r => r.status === 'ready' && r.inclusion !== 'never' && (r.summary || r.microLabel))
    .slice()
    .reverse() // listProjectFiles queries ascending (oldest-first) — flip to newest-first
    .map(r => ({
      kind: 'file' as const,
      id: r.fileId as string,
      title: r.filename as string,
      summary: (r.summary as string | undefined) ?? (r.microLabel as string) ?? '',
      projectId,
    }))
}

/**
 * Builds the search_history corpus for one scope. 'project' covers chats + files of exactly
 * ctx.projectId. 'global' covers all of the user's chats plus a capped sweep of their projects'
 * files. Exported for direct unit testing alongside searchHistory().
 */
export async function buildSearchHistoryCorpus(
  sub: string,
  scope: 'project' | 'global',
  projectId?: string,
): Promise<SearchHistoryCorpusItem[]> {
  if (scope === 'project' && projectId) {
    const [chats, files] = await Promise.all([
      chatCorpusItems(sub, projectId),
      fileCorpusItemsForProject(projectId),
    ])
    return [...chats, ...files]
  }

  const [chats, projectRows] = await Promise.all([chatCorpusItems(sub), listProjects(sub)])
  const sweepProjects = projectRows.slice(0, SEARCH_HISTORY_PROJECT_SWEEP_CAP)
  const fileLists = await Promise.all(
    sweepProjects.map(p => fileCorpusItemsForProject(projectIdFromRow(p))),
  )
  return [...chats, ...fileLists.flat()]
}

/**
 * The search_history tool executor. Builds the scoped corpus, ranks it via searchHistory(), and
 * returns a {results,text} JSON envelope — the same {result(s),text} shape web_search/web_fetch
 * already use, so the model can both render cards (results) and talk about what it found (text).
 */
export async function executeSearchHistoryTool(
  input: Record<string, unknown>,
  ctx: SearchHistoryContext,
): Promise<ToolResult> {
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (!query) {
    return { entries: [{ kind: 'text', text: 'Missing query' }], isError: true }
  }

  const requestedScope = input.scope === 'project' || input.scope === 'global' ? input.scope : undefined
  const scope: 'project' | 'global' = ctx.searchScope ?? requestedScope ?? (ctx.projectId ? 'project' : 'global')

  const corpus = await buildSearchHistoryCorpus(ctx.sub, scope, ctx.projectId)
  const results = await searchHistory(corpus, query, { scope, chatId: ctx.chatId })

  console.log(JSON.stringify({ event: 'search_history', scope, corpusSize: corpus.length, resultCount: results.length, chatId: ctx.chatId }))

  const text = results.length > 0
    ? results.map(r => `[${r.kind}:${r.id}] ${r.title} — ${r.reason}`).join('\n')
    : 'No relevant past chats or files found.'

  return { entries: [{ kind: 'text', text: JSON.stringify({ results, text }) }], isError: false }
}
