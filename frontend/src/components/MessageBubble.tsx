import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faChevronDown, faChevronRight, faChevronLeft, faGlobe, faLink, faSpinner,
  faCircleCheck, faCircleXmark, faBrain, faRotateRight, faPenToSquare,
} from '@fortawesome/free-solid-svg-icons'
import type { Message, Step, TokenUsage } from '../api/http'
import type { StreamingMsg } from '../store/chatStore'
import type { SearchResult } from '../lib/toolResults'

// ── URL sanitizer — blocks javascript: and data: URIs ────────────────────────

export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') ? url : '#'
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

// ── Tool call display ─────────────────────────────────────────────────────────

function ToolCallPill({ step }: { step: Extract<Step, { kind: 'tool' }>; streaming?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const pending = step.result === undefined
  const hasResults = !!step.searchResults?.length
  const icon = pending ? faSpinner : step.isError ? faCircleXmark : faCircleCheck
  const label = step.name === 'web_search' ? `Search: ${safeInput(step.input, 'query')}`
              : step.name === 'web_fetch'  ? `Fetch: ${safeInput(step.input, 'url')}`
              : step.name

  return (
    <div className={`tool-pill${step.isError ? ' error' : pending ? ' pending' : ''}`}>
      <button className="tool-pill-header" onClick={() => !pending && setExpanded(e => !e)}>
        <FontAwesomeIcon icon={faGlobe} className="tool-icon" />
        <span className="tool-label">{label}</span>
        <FontAwesomeIcon icon={icon} className="tool-status" spin={pending} />
        {!pending && (
          <FontAwesomeIcon icon={expanded ? faChevronDown : faChevronRight} className="tool-chevron" />
        )}
      </button>
      {expanded && step.result !== undefined && (
        <div className="tool-result-body">
          {hasResults ? (
            <div className="search-results">
              {step.searchResults!.map((r: SearchResult, i: number) => (
                <SearchResultCard key={r.url} r={r} index={i} />
              ))}
            </div>
          ) : (
            <pre>{step.result.slice(0, 3000)}{step.result.length > 3000 ? '\n[...]' : ''}</pre>
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

// ── Usage stats footer ────────────────────────────────────────────────────────

export function UsageStats({ usage, label }: { usage: TokenUsage; label?: string }) {
  const parts: string[] = []
  parts.push(`↑${usage.inputTokens} ↓${usage.outputTokens}`)
  if (usage.cacheReadInputTokens) parts.push(`cache hit ${usage.cacheReadInputTokens}`)
  if (usage.cacheWriteInputTokens) parts.push(`cache write ${usage.cacheWriteInputTokens}`)
  return (
    <div className="usage-stats">
      {label && <span className="usage-label">{label}</span>}
      <span className="usage-tokens">{parts.join(' · ')}</span>
    </div>
  )
}

// ── Main bubble ───────────────────────────────────────────────────────────────

interface Props {
  message: Message | StreamingMsg
  onRerun?: (parentId: string) => void
  onNavigate?: (targetMsgId: string) => void
  onEdit?: (msgId: string, parentId: string | null, content: string) => void
}

/**
 * Renders a chat bubble.  For StreamingMsg, steps may be in progress (last
 * thinking/text step still accumulating, tool result pending).  For Message,
 * all steps are final.
 *
 * Steps are rendered in arrival order — exactly as they appear in steps[].
 * This preserves the think → search → think → answer interleaved structure.
 */
export default function MessageBubble({ message, onRerun, onNavigate, onEdit }: Props) {
  const isAssistant = message.role === 'assistant'
  const isStreaming = 'streaming' in message && message.streaming
  const waiting = 'waiting' in message && message.waiting
  const steps: Step[] = message.steps ?? []
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  // For a streaming message, the last step is "open" (still accumulating).
  // A thinking step is done when the next non-thinking step exists after it.
  function isThinkingDone(stepIndex: number): boolean {
    if (!isStreaming) return true
    // If there's any step after this one, the thinking is done
    return stepIndex < steps.length - 1
  }

  function isLastTextStep(stepIndex: number): boolean {
    return isStreaming && stepIndex === steps.length - 1 && steps[stepIndex].kind === 'text'
  }

  return (
    <div className={`message ${message.role}`}>
      <div className="message-content">
        {/* Waiting indicator — shown before any steps arrive */}
        {isAssistant && waiting && steps.length === 0 && (
          <span className="waiting-indicator">
            <FontAwesomeIcon icon={faSpinner} spin />
            <span>Processing…</span>
          </span>
        )}

        {/* Render steps in order */}
        {steps.map((step, i) => {
          // Strip internal _done sentinel from display
          const cleanStep = step as Step & { _done?: boolean }

          if (cleanStep.kind === 'thinking') {
            return (
              <ThinkingBlock
                key={i}
                text={cleanStep.text}
                done={isThinkingDone(i)}
                streaming={isStreaming}
              />
            )
          }
          if (cleanStep.kind === 'tool') {
            return (
              <ToolCallPill
                key={cleanStep.toolUseId}
                step={cleanStep}
                streaming={isStreaming}
              />
            )
          }
          if (cleanStep.kind === 'text') {
            if (!isAssistant) {
              return editing ? null : <span key={i}>{cleanStep.text}</span>
            }
            return (
              <div key={i} className="md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {cleanStep.text || ''}
                </ReactMarkdown>
                {isLastTextStep(i) && <span className="cursor">▋</span>}
              </div>
            )
          }
          return null
        })}

        {/* Inline edit textarea — shown when user clicks Edit on their own bubble */}
        {!isAssistant && editing && (
          <>
            <textarea
              className="edit-textarea system-prompt-input"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setEditing(false) }}
              autoFocus
              rows={3}
            />
            <div className="edit-actions">
              <button
                className="action-btn"
                title="Save edit"
                onClick={() => {
                  if (draft.trim() && onEdit) {
                    const msg = message as Message
                    onEdit(msg.msgId, msg.parentId ?? null, draft.trim())
                  }
                  setEditing(false)
                }}
              >
                Save
              </button>
              <button className="action-btn" title="Cancel edit" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>

      {/* Hover action-row — only for finalized (non-streaming) user bubbles with onEdit */}
      {!isAssistant && !isStreaming && !editing && onEdit && 'msgId' in message && (
        <div className="message-actions">
          <button
            className="action-btn"
            title="Edit this question"
            onClick={() => {
              const text = (message as Message).steps?.find(s => s.kind === 'text')?.text ?? ''
              setDraft(text)
              setEditing(true)
            }}
          >
            <FontAwesomeIcon icon={faPenToSquare} />
          </button>
        </div>
      )}

      {/* Hover action-row — only for finalized (non-streaming) assistant bubbles with a parentId */}
      {isAssistant && !isStreaming && onRerun && 'parentId' in message && message.parentId != null && (
        <div className="message-actions">
          <button
            className="action-btn"
            title="Re-run this answer"
            onClick={() => onRerun((message as Message).parentId!)}
          >
            <FontAwesomeIcon icon={faRotateRight} />
          </button>
        </div>
      )}

      {/* Sibling navigation — visible on any finalized bubble with siblings */}
      {!isStreaming && onNavigate && 'siblingCount' in message &&
        (message as Message).siblingCount != null &&
        (message as Message).siblingCount! > 1 && (() => {
          const msg = message as Message
          const idx = msg.siblingIndex!
          const count = msg.siblingCount!
          const siblings = msg.siblings!
          return (
            <div className="sibling-nav">
              <button
                className="sibling-btn"
                title="Previous variant"
                disabled={idx <= 1}
                onClick={() => onNavigate(siblings[idx - 2])}
              >
                <FontAwesomeIcon icon={faChevronLeft} />
              </button>
              <span className="sibling-label">{idx}/{count}</span>
              <button
                className="sibling-btn"
                title="Next variant"
                disabled={idx >= count}
                onClick={() => onNavigate(siblings[idx])}
              >
                <FontAwesomeIcon icon={faChevronRight} />
              </button>
            </div>
          )
        })()
      }

    </div>
  )
}
