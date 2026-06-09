import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faChevronDown, faChevronRight, faGlobe, faSpinner, faCircleCheck, faCircleXmark } from '@fortawesome/free-solid-svg-icons'
import type { Message } from '../api/http'
import type { StreamingMsg, ToolCall } from '../store/chatStore'

// ── Tool call display ─────────────────────────────────────────────────────────

function ToolCallPill({ tc }: { tc: ToolCall }) {
  const [expanded, setExpanded] = useState(false)
  const pending = tc.result === undefined
  const icon = pending ? faSpinner : tc.isError ? faCircleXmark : faCircleCheck
  const label = tc.name === 'web_search' ? `Search: ${safeInput(tc.input, 'query')}`
              : tc.name === 'web_fetch'  ? `Fetch: ${safeInput(tc.input, 'url')}`
              : tc.name

  return (
    <div className={`tool-pill${tc.isError ? ' error' : pending ? ' pending' : ''}`}>
      <button className="tool-pill-header" onClick={() => setExpanded(e => !e)}>
        <FontAwesomeIcon icon={faGlobe} className="tool-icon" />
        <span className="tool-label">{label}</span>
        <FontAwesomeIcon icon={icon} className="tool-status" spin={pending} />
        {tc.result !== undefined && (
          <FontAwesomeIcon icon={expanded ? faChevronDown : faChevronRight} className="tool-chevron" />
        )}
      </button>
      {expanded && tc.result !== undefined && (
        <div className="tool-result-body">
          <pre>{tc.result.slice(0, 2000)}{tc.result.length > 2000 ? '\n[...]' : ''}</pre>
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
  const label = done ? 'Thinking' : 'Thinking…'
  return (
    <div className={`thinking-block${open ? ' open' : ''}`}>
      <button className="thinking-header" onClick={() => setOpen(o => !o)}>
        <FontAwesomeIcon icon={open ? faChevronDown : faChevronRight} />
        <span>{label}</span>
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
  isStreaming?: boolean
}

export default function MessageBubble({ message, isStreaming }: Props) {
  const isAssistant = message.role === 'assistant'
  const streaming = 'streaming' in message && message.streaming
  const waiting = 'waiting' in message && message.waiting

  const thinking = 'thinking' in message ? message.thinking : undefined
  const thinkingDone = 'thinkingDone' in message ? message.thinkingDone : true
  const toolCalls = 'toolCalls' in message ? message.toolCalls : undefined

  return (
    <div className={`message ${message.role}`}>
      <div className="message-content">
        {/* Waiting indicator — shown until first content event */}
        {isAssistant && waiting && (
          <span className="waiting-indicator">
            <FontAwesomeIcon icon={faSpinner} spin />
            <span>Thinking…</span>
          </span>
        )}

        {/* Thinking block — only for assistant */}
        {isAssistant && !waiting && thinking !== undefined && thinking.length > 0 && (
          <ThinkingBlock text={thinking} done={!!thinkingDone} streaming={!!streaming} />
        )}

        {/* Tool call pills */}
        {!waiting && toolCalls && toolCalls.map(tc => (
          <ToolCallPill key={tc.toolUseId} tc={tc} />
        ))}

        {/* Message text — markdown for assistant, plain for user */}
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
