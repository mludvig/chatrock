import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faChevronDown, faChevronRight, faGlobe, faLink, faSpinner,
  faCircleCheck, faCircleXmark, faBrain,
} from '@fortawesome/free-solid-svg-icons'
import type { Message } from '../api/http'
import type { StreamingMsg, ToolCall, SearchResult } from '../store/chatStore'

// ── Search result cards ───────────────────────────────────────────────────────

function SearchResultCard({ r, index }: { r: SearchResult; index: number }) {
  return (
    <a className="search-result-card" href={r.url} target="_blank" rel="noopener noreferrer">
      <span className="src-index">{index + 1}</span>
      <span className="src-body">
        <span className="src-title">{r.title || r.url}</span>
        <span className="src-url">
          <FontAwesomeIcon icon={faLink} />
          {new URL(r.url).hostname}
        </span>
        {r.description && <span className="src-desc">{r.description}</span>}
      </span>
    </a>
  )
}

// ── Tool call display ─────────────────────────────────────────────────────────

function ToolCallPill({ tc }: { tc: ToolCall }) {
  const [expanded, setExpanded] = useState(false)
  const pending = tc.result === undefined
  const hasResults = !!tc.searchResults?.length
  const icon = pending ? faSpinner : tc.isError ? faCircleXmark : faCircleCheck
  const label = tc.name === 'web_search' ? `Search: ${safeInput(tc.input, 'query')}`
              : tc.name === 'web_fetch'  ? `Fetch: ${safeInput(tc.input, 'url')}`
              : tc.name

  return (
    <div className={`tool-pill${tc.isError ? ' error' : pending ? ' pending' : ''}`}>
      <button className="tool-pill-header" onClick={() => !pending && setExpanded(e => !e)}>
        <FontAwesomeIcon icon={faGlobe} className="tool-icon" />
        <span className="tool-label">{label}</span>
        <FontAwesomeIcon icon={icon} className="tool-status" spin={pending} />
        {!pending && (
          <FontAwesomeIcon icon={expanded ? faChevronDown : faChevronRight} className="tool-chevron" />
        )}
      </button>
      {expanded && tc.result !== undefined && (
        <div className="tool-result-body">
          {hasResults ? (
            <div className="search-results">
              {tc.searchResults!.map((r, i) => (
                <SearchResultCard key={r.url} r={r} index={i} />
              ))}
            </div>
          ) : (
            <pre>{tc.result.slice(0, 3000)}{tc.result.length > 3000 ? '\n[...]' : ''}</pre>
          )}
        </div>
      )}
    </div>
  )
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

// ── Thinking block ────────────────────────────────────────────────────────────

function ThinkingBlock({ text, done, streaming }: { text: string; done: boolean; streaming: boolean }) {
  const [open, setOpen] = useState(false)
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

// ── Main bubble ───────────────────────────────────────────────────────────────

interface Props {
  message: Message | StreamingMsg
}

export default function MessageBubble({ message }: Props) {
  const isAssistant = message.role === 'assistant'
  const streaming = 'streaming' in message && message.streaming
  const waiting = 'waiting' in message && message.waiting

  const thinking = message.thinking
  const thinkingDone = 'thinkingDone' in message ? (message.thinkingDone ?? false) : true
  const toolCalls = message.toolCalls

  return (
    <div className={`message ${message.role}`}>
      <div className="message-content">
        {/* Waiting indicator */}
        {isAssistant && waiting && (
          <span className="waiting-indicator">
            <FontAwesomeIcon icon={faSpinner} spin />
            <span>Processing…</span>
          </span>
        )}

        {/* Thinking block */}
        {isAssistant && !waiting && thinking && thinking.length > 0 && (
          <ThinkingBlock text={thinking} done={thinkingDone} streaming={!!streaming} />
        )}

        {/* Tool call pills */}
        {!waiting && toolCalls && toolCalls.map(tc => (
          <ToolCallPill key={tc.toolUseId} tc={tc} />
        ))}

        {/* Message text */}
        {isAssistant && !waiting ? (
          <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content || ''}
            </ReactMarkdown>
            {streaming && <span className="cursor">▋</span>}
          </div>
        ) : !isAssistant ? (
          <span>{message.content}</span>
        ) : null}
      </div>
    </div>
  )
}
