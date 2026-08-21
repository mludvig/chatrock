import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faChevronDown, faChevronRight, faGlobe, faLink, faSpinner, faCircleCheck,
  faCircleXmark, faBrain, faFile, faComments, faMagnifyingGlass, faMemory, faImage,
} from '@fortawesome/free-solid-svg-icons'
import type { Step } from '../api/http'
import { useChatStore } from '../store/chatStore'
import type { SearchResult, SearchHistoryResult } from '../lib/toolResults'

// The renderers for one step of a turn — a thinking block or a tool call — shared by
// MessageBubble (a chat turn's steps) and ResearchPanel (a Deep Research run's live
// progress), so research progress looks identical to any other tool use rather than
// growing a second, divergent set of pills.

// ── URL sanitizer — blocks javascript: and data: URIs ────────────────────────

export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    // Allow blob: for local ObjectURL previews (attachment thumbnails before upload completes)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'blob:') return url
    return '#'
  } catch {
    return '#'
  }
}

// ── Search result cards ───────────────────────────────────────────────────────

function SearchResultCard({ r, index }: { r: SearchResult; index: number }) {
  return (
    <a className="search-result-card" href={sanitizeUrl(r.url)} target="_blank" rel="noopener noreferrer">
      <span className="src-index">{index + 1}</span>
      <span className="src-body">
        <span className="src-title">{r.title || r.url}</span>
        <span className="src-url">
          <FontAwesomeIcon icon={faLink} />
          {sanitizeUrl(r.url) !== '#' ? new URL(r.url).hostname : r.url}
        </span>
        {r.description && <span className="src-desc">{r.description}</span>}
      </span>
    </a>
  )
}

// Search-history result card — internal navigation (chat → /c/:id, file → its project at
// /p/:projectId, since there's no standalone file route). A file result with no projectId
// (shouldn't happen in practice — every file belongs to a project) renders inert rather than a
// dead link.
function SearchHistoryResultCard({ r }: { r: SearchHistoryResult }) {
  const to = r.kind === 'chat' ? `/c/${r.id}` : (r.projectId ? `/p/${r.projectId}` : undefined)
  const body = (
    <span className="src-body">
      <span className="src-title">{r.title}</span>
      <span className="src-desc">{r.reason}</span>
    </span>
  )
  const icon = r.kind === 'chat' ? faComments : faFile
  if (!to) {
    return (
      <span className="search-result-card search-history-result-card disabled">
        <FontAwesomeIcon icon={icon} className="src-index" />
        {body}
      </span>
    )
  }
  return (
    <Link className="search-result-card search-history-result-card" to={to}>
      <FontAwesomeIcon icon={icon} className="src-index" />
      {body}
    </Link>
  )
}

// ── Tool call display ─────────────────────────────────────────────────────────

export function ToolCallPill({ step }: { step: Extract<Step, { kind: 'tool' }>; streaming?: boolean }) {
  // generate_image's whole point IS the image — unlike an incidental browser screenshot,
  // it shouldn't be hidden behind a click.
  const [expanded, setExpanded] = useState(() => step.name === 'generate_image')
  const { projectFilesById, chats } = useChatStore()
  const pending = step.result === undefined
  const hasResults = !!step.searchResults?.length
  const hasSearchHistoryResults = !!step.searchHistoryResults?.length
  const hasScreenshots = !!step.screenshotUrls?.length
  const isMemoryTool = MEMORY_TOOLS.has(step.name)
  const mem = isMemoryTool ? memoryInput(step.input) : null
  const icon = pending ? faSpinner : step.isError ? faCircleXmark : faCircleCheck
  const label = isMemoryTool
    ? memoryLabel(step.name, step.input)
    : step.name === 'search_history'
    ? `Search history: ${safeInput(step.input, 'query')}`
    : step.name === 'web_search'
    ? `Search: ${safeInput(step.input, 'query')}`
    : step.name === 'web_fetch'
    ? `Fetch: ${safeInput(step.input, 'url')}`
    : step.name === 'take_screenshot'
    ? `Screenshot: ${safeInput(step.input, 'url')}`
    : step.name === 'get_rendered_page'
    ? `Page: ${safeInput(step.input, 'url')}`
    : step.name === 'browse_web'
    ? `Browse: ${firstBrowserUrl(step.input)}`
    : step.name === 'generate_image'
    ? `Image: ${safeInput(step.input, 'prompt')}`
    : step.name === 'read_project_file'
    ? (() => {
        const fid = safeInput(step.input, 'fileId')
        const name = projectFilesById[fid]?.filename ?? fid.slice(0, 8)
        const detail = safeInput(step.input, 'detail')
        return `File: ${name}${detail === 'summary' ? ' (summary)' : ''}`
      })()
    : step.name === 'read_project_chat'
    ? (() => {
        const cid = safeInput(step.input, 'chatId')
        const title = chats.find(c => c.chatId === cid)?.title ?? cid.slice(0, 8)
        const detail = safeInput(step.input, 'detail')
        return `Chat: ${title}${detail === 'summary' ? ' (summary)' : ''}`
      })()
    : step.name

  return (
    <div className={`tool-pill${step.isError ? ' error' : pending ? ' pending' : ''}`}>
      <button className="tool-pill-header" onClick={() => !pending && setExpanded(e => !e)}>
        <FontAwesomeIcon icon={isMemoryTool ? faMemory : step.name === 'search_history' ? faMagnifyingGlass : step.name === 'generate_image' ? faImage : faGlobe} className="tool-icon" />
        <span className="tool-label">{label}</span>
        <FontAwesomeIcon icon={icon} className="tool-status" spin={pending} />
        {!pending && (
          <FontAwesomeIcon icon={expanded ? faChevronDown : faChevronRight} className="tool-chevron" />
        )}
      </button>
      {expanded && step.result !== undefined && (
        <div className="tool-result-body">
          {hasScreenshots && (
            // Thumbnails — click opens the full-resolution image in a new tab (same pattern
            // as AttachmentBlock's user-uploaded images).
            <div className="browser-screenshots">
              {step.screenshotUrls!.map((url, i) => (
                <a key={url} href={sanitizeUrl(url)} target="_blank" rel="noopener noreferrer">
                  <img src={sanitizeUrl(url)} alt={`Screenshot ${i + 1}`} className="attachment-thumbnail" />
                </a>
              ))}
            </div>
          )}
          {isMemoryTool && mem ? (
            <div className="memory-update-card">
              <div className="memory-update-head">
                <span className="memory-update-op">
                  {mem.operation === 'forget' ? 'Forgot' : mem.operation === 'update' ? 'Updated' : 'Remembered'}
                  {step.name === 'manage_project_memory' ? ' project memory' : ' memory'}
                </span>
                {mem.category && <span className="memory-update-cat">{mem.category}</span>}
              </div>
              {mem.text && <div className="memory-update-text">{mem.text}</div>}
              {step.result && <div className="memory-update-result">{step.result}</div>}
            </div>
          ) : hasSearchHistoryResults ? (
            <div className="search-results">
              {step.searchHistoryResults!.map((r: SearchHistoryResult) => (
                <SearchHistoryResultCard key={`${r.kind}:${r.id}`} r={r} />
              ))}
            </div>
          ) : hasResults ? (
            <div className="search-results">
              {step.searchResults!.map((r: SearchResult, i: number) => (
                <SearchResultCard key={r.url} r={r} index={i} />
              ))}
            </div>
          ) : step.result ? (
            <pre>{step.result.slice(0, 3000)}{step.result.length > 3000 ? '\n[...]' : ''}</pre>
          ) : null}
        </div>
      )}
    </div>
  )
}

const MEMORY_TOOLS = new Set(['manage_memory', 'manage_project_memory'])

/** Parsed view of a manage_memory / manage_project_memory tool input. */
function memoryInput(inputJson: string): { operation: string; text: string; category: string; memId: string } {
  try {
    const o = JSON.parse(inputJson) as Record<string, string>
    return { operation: o.operation ?? '', text: o.text ?? '', category: o.category ?? '', memId: o.memId ?? '' }
  } catch {
    return { operation: '', text: '', category: '', memId: '' }
  }
}

/** Collapsed-pill label for a memory tool, e.g. "Remember: …" / "Update project memory: …". */
function memoryLabel(name: string, inputJson: string): string {
  const { operation, text } = memoryInput(inputJson)
  const proj = name === 'manage_project_memory'
  const shortText = text.length > 60 ? text.slice(0, 60) + '…' : text
  if (operation === 'forget') return proj ? 'Forget project memory' : 'Forget memory'
  const noun = proj ? 'project memory' : 'memory'
  if (operation === 'update') return shortText ? `Update ${noun}: ${shortText}` : `Update ${noun}`
  // remember (default)
  const lead = proj ? 'Remember (project)' : 'Remember'
  return shortText ? `${lead}: ${shortText}` : lead
}

function safeInput(inputJson: string, key: string): string {
  try {
    const obj = JSON.parse(inputJson) as Record<string, string>
    const val = obj[key] ?? ''
    return val.length > 60 ? val.slice(0, 60) + '…' : val
  } catch {
    return inputJson.slice(0, 60)
  }
}

function firstBrowserUrl(inputJson: string): string {
  try {
    const obj = JSON.parse(inputJson) as { steps?: Array<{ tool?: string; params?: { url?: string } }> }
    const steps = obj.steps ?? []
    const nav = steps.find(s => s.tool === 'browser_navigate')
    if (nav?.params?.url) {
      const url = nav.params.url
      return url.length > 60 ? url.slice(0, 60) + '…' : url
    }
    return `${steps.length} step${steps.length === 1 ? '' : 's'}`
  } catch {
    return 'browse'
  }
}

// ── Thinking block ────────────────────────────────────────────────────────────

export function ThinkingBlock({ text, done, streaming }: { text: string; done: boolean; streaming: boolean }) {
  // Auto-open while thinking is live; auto-collapse once done so the answer isn't buried.
  const [open, setOpen] = useState(!done)
  useEffect(() => { if (done) setOpen(false) }, [done])

  // Some reasoning blocks carry only a signature (or are fully redacted) and have
  // no visible text — Bedrock legitimately returns these. Nothing useful to show,
  // so render nothing rather than an empty/placeholder box.
  if (done && text.trim() === '') {
    return null
  }

  return (
    <div className={`thinking-block${open ? ' open' : ''}`}>
      <button className="thinking-header" onClick={() => setOpen(o => !o)}>
        <FontAwesomeIcon icon={faChevronDown} className={`thinking-chevron${open ? ' rotated' : ''}`} />
        <FontAwesomeIcon icon={faBrain} className="thinking-brain" />
        <span>{done ? 'Thought' : 'Thinking…'}</span>
        {!done && <FontAwesomeIcon icon={faSpinner} spin className="thinking-spinner" />}
      </button>
      {open && (
        <div className="thinking-body">
          {text}
          {!done && streaming && <span className="cursor">▋</span>}
        </div>
      )}
    </div>
  )
}
