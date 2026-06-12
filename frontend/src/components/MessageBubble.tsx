import { useState, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import terraform from 'react-syntax-highlighter/dist/esm/languages/prism/hcl'

SyntaxHighlighter.registerLanguage('tsx', tsx)
SyntaxHighlighter.registerLanguage('typescript', typescript)
SyntaxHighlighter.registerLanguage('ts', typescript)
SyntaxHighlighter.registerLanguage('jsx', jsx)
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('js', javascript)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('py', python)
SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('sh', bash)
SyntaxHighlighter.registerLanguage('shell', bash)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('yaml', yaml)
SyntaxHighlighter.registerLanguage('yml', yaml)
SyntaxHighlighter.registerLanguage('markdown', markdown)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('sql', sql)
SyntaxHighlighter.registerLanguage('java', java)
SyntaxHighlighter.registerLanguage('go', go)
SyntaxHighlighter.registerLanguage('rust', rust)
SyntaxHighlighter.registerLanguage('terraform', terraform)
SyntaxHighlighter.registerLanguage('hcl', terraform)
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faChevronDown, faChevronRight, faChevronLeft, faGlobe, faLink, faSpinner,
  faCircleCheck, faCircleXmark, faBrain, faRotateRight, faPenToSquare, faPaperPlane,
  faCodeBranch, faCopy, faCheck, faTrash, faRobot, faCoins, faClock, faFile,
} from '@fortawesome/free-solid-svg-icons'
import type { Message, Step, TokenUsage } from '../api/http'
import type { StreamingMsg } from '../store/chatStore'
import type { SearchResult } from '../lib/toolResults'

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

// ── Code block with copy button ──────────────────────────────────────────────

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <div className="code-block">
      <div className="code-block-header">
        {language && <span className="code-lang">{language}</span>}
        <button className="code-copy-btn" onClick={copy} title="Copy code">
          <FontAwesomeIcon icon={copied ? faCheck : faCopy} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={oneDark}
        customStyle={{ margin: 0, borderRadius: '0 0 6px 6px', fontSize: '13px' }}
        PreTag="div"
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}

// react-markdown components prop — shared between user and assistant bubbles
const mdComponents = {
  code({ className, children, ...props }: React.HTMLAttributes<HTMLElement> & { inline?: boolean }) {
    const match = /language-(\w+)/.exec(className ?? '')
    const language = match ? match[1] : ''
    const code = String(children).replace(/\n$/, '')
    // inline code — no block treatment
    const isInline = !className && !code.includes('\n')
    if (isInline) {
      return <code className="inline-code" {...props}>{children}</code>
    }
    return <CodeBlock language={language} code={code} />
  },
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

// ── Attachment block (images + documents) ───────────────────────────────────

function AttachmentBlock({ step }: { step: Extract<Step, { kind: 'attachment' }> }) {
  const safeUrl = sanitizeUrl(step.url)
  if (step.attachmentKind === 'image') {
    return (
      <div className="attachment-block attachment-block--image">
        <a href={safeUrl} target="_blank" rel="noopener noreferrer">
          <img src={safeUrl} alt={step.filename} className="attachment-thumbnail" />
        </a>
        <span className="attachment-filename">{step.filename}</span>
      </div>
    )
  }
  const modeLabel = step.mode === 'rich' ? ' (Rich)' : step.mode === 'standard' ? ' (Standard)' : ''
  return (
    <div className="attachment-block attachment-block--doc">
      <a className="attachment-chip" href={safeUrl} target="_blank" rel="noopener noreferrer">
        <FontAwesomeIcon icon={faFile} className="attachment-icon" />
        <span className="attachment-filename">{step.filename}</span>
        {modeLabel && <span className="attachment-mode">{modeLabel}</span>}
      </a>
    </div>
  )
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

// Format token counts: raw if < 5 000; one-decimal k/M above that.
// Trims trailing ".0" so "8.0k" → "8k".
function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const s = (n / 1_000_000).toFixed(1)
    return (s.endsWith('.0') ? s.slice(0, -2) : s) + 'M'
  }
  if (n >= 5000) {
    const s = (n / 1000).toFixed(1)
    return (s.endsWith('.0') ? s.slice(0, -2) : s) + 'k'
  }
  return String(n)
}

export function UsageStats({ usage, label }: { usage: TokenUsage; label?: string }) {
  const parts: string[] = []
  parts.push(`↑${fmtTokens(usage.inputTokens)} ↓${fmtTokens(usage.outputTokens)}`)
  if (usage.cacheReadInputTokens) parts.push(`cache hit ${fmtTokens(usage.cacheReadInputTokens)}`)
  if (usage.cacheWriteInputTokens) parts.push(`cache write ${fmtTokens(usage.cacheWriteInputTokens)}`)
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
  onEditRequest?: (message: Message) => void
  onForkToHere?: (msgId: string, role: 'user' | 'assistant', text: string) => void
  onDeleteBranch?: (msgId: string) => void
}

/**
 * Renders a chat bubble.  For StreamingMsg, steps may be in progress (last
 * thinking/text step still accumulating, tool result pending).  For Message,
 * all steps are final.
 *
 * Steps are rendered in arrival order — exactly as they appear in steps[].
 * This preserves the think → search → think → answer interleaved structure.
 */
const MessageBubble = memo(function MessageBubble({ message, onRerun, onNavigate, onEdit, onEditRequest, onForkToHere, onDeleteBranch }: Props) {
  const isAssistant = message.role === 'assistant'
  const isStreaming = 'streaming' in message && message.streaming
  const waiting = 'waiting' in message && message.waiting
  const steps: Step[] = message.steps ?? []
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)

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
    <div className={`message ${message.role}${editing ? ' editing' : ''}`}>
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
          if (cleanStep.kind === 'attachment') {
            return (
              <AttachmentBlock
                key={`att-${i}`}
                step={cleanStep}
              />
            )
          }
          if (cleanStep.kind === 'text') {
            if (!isAssistant) {
              return editing ? null : (
                <div key={i} className="md md--user">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                    {cleanStep.text || ''}
                  </ReactMarkdown>
                </div>
              )
            }
            return (
              <div key={i} className="md">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {cleanStep.text || ''}
                </ReactMarkdown>
                {isLastTextStep(i) && <span className="cursor">▋</span>}
              </div>
            )
          }
          return null
        })}

      </div>

      {/* Per-message metadata line — assistant bubbles only, not streaming */}
      {isAssistant && !isStreaming && 'model' in message && (message as Message).createdAt && (() => {
        const msg = message as Message
        const modelShort = msg.model.replace(/^global\.anthropic\./, '').replace(/-\d{8,}.*$/, '')
        const ts = new Date(msg.createdAt)
        const timeStr = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        const dateStr = ts.toLocaleDateString([], { month: 'short', day: 'numeric' })
        return (
          <div className="msg-meta">
            <span className="msg-meta-item">
              <FontAwesomeIcon icon={faRobot} />
              {modelShort}
            </span>
            {msg.usage && (
              <span className="msg-meta-item">
                <FontAwesomeIcon icon={faCoins} />
                {fmtTokens(msg.usage.inputTokens + msg.usage.outputTokens)} tok
                {msg.usage.cacheReadInputTokens ? ` · ${fmtTokens(msg.usage.cacheReadInputTokens)} cached` : ''}
              </span>
            )}
            <span className="msg-meta-item">
              <FontAwesomeIcon icon={faClock} />
              {dateStr} {timeStr}
            </span>
            {msg.thinkingEffort && msg.thinkingEffort !== 'off' && (
              <span className="msg-meta-item">
                <FontAwesomeIcon icon={faBrain} />
                {msg.thinkingEffort}
              </span>
            )}
            {msg.webSearch === false && (
              <span className="msg-meta-item">
                <FontAwesomeIcon icon={faGlobe} />
                no web
              </span>
            )}
          </div>
        )
      })()}

      {/* Edit area — outside the bubble so it gets full message width */}
      {!isAssistant && editing && (
        <div className="edit-area">
          <textarea
            className="edit-textarea"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') setEditing(false)
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (draft.trim() && onEdit) {
                  const msg = message as Message
                  onEdit(msg.msgId, msg.parentId ?? null, draft.trim())
                }
                setEditing(false)
              }
            }}
            autoFocus
            rows={3}
          />
          <div className="edit-actions">
            <button
              className="edit-send-btn"
              title="Send edited message"
              onClick={() => {
                if (draft.trim() && onEdit) {
                  const msg = message as Message
                  onEdit(msg.msgId, msg.parentId ?? null, draft.trim())
                }
                setEditing(false)
              }}
            >
              Send <FontAwesomeIcon icon={faPaperPlane} />
            </button>
            <button className="edit-cancel-btn" title="Cancel edit (Esc)" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Always-visible bottom row: sibling nav first, then action icons */}
      {!isStreaming && (() => {
        const hasSiblings = onNavigate && 'siblingCount' in message &&
          (message as Message).siblingCount != null &&
          (message as Message).siblingCount! > 1
        const hasEdit = !isAssistant && !editing && (onEdit || onEditRequest) && 'msgId' in message
        const hasRerun = isAssistant && onRerun && 'parentId' in message && message.parentId != null
        const hasForkCopy = 'msgId' in message
        const hasDelete = onDeleteBranch && 'msgId' in message && (message as Message).parentId != null
        if (!hasSiblings && !hasEdit && !hasRerun && !hasForkCopy && !hasDelete) return null

        const msg = message as Message
        // Concatenate text steps for copy/fork
        const bubbleText = (msg.steps ?? []).filter(s => s.kind === 'text').map(s => s.text).join('\n')

        return (
          <div className="bubble-row">
            {hasSiblings && (() => {
              const idx = msg.siblingIndex!
              const count = msg.siblingCount!
              const siblings = msg.siblings!
              return (
                <>
                  <button
                    className="sibling-btn"
                    title="Previous variant"
                    disabled={idx <= 1}
                    onClick={() => onNavigate!(siblings[idx - 2])}
                  >
                    <FontAwesomeIcon icon={faChevronLeft} />
                  </button>
                  <span className="sibling-label">{idx}/{count}</span>
                  <button
                    className="sibling-btn"
                    title="Next variant"
                    disabled={idx >= count}
                    onClick={() => onNavigate!(siblings[idx])}
                  >
                    <FontAwesomeIcon icon={faChevronRight} />
                  </button>
                </>
              )
            })()}
            {hasEdit && (
              <button
                className="action-btn"
                title="Edit this question"
                onClick={() => {
                  if (onEditRequest) {
                    onEditRequest(msg)
                  } else {
                    const text = msg.steps?.find(s => s.kind === 'text')?.text ?? ''
                    setDraft(text)
                    setEditing(true)
                  }
                }}
              >
                <FontAwesomeIcon icon={faPenToSquare} />
              </button>
            )}
            {hasRerun && (
              <button
                className="action-btn"
                title="Re-run this answer"
                onClick={() => onRerun!(msg.parentId!)}
              >
                <FontAwesomeIcon icon={faRotateRight} />
              </button>
            )}
            {hasForkCopy && onForkToHere && (
              <button
                className="action-btn"
                title="Fork to a new chat (up to here)"
                onClick={() => {
                  if (window.confirm('Fork this conversation into a new chat?')) {
                    onForkToHere(msg.msgId, msg.role, bubbleText)
                  }
                }}
              >
                <FontAwesomeIcon icon={faCodeBranch} />
              </button>
            )}
            {hasForkCopy && (
              <button
                className="action-btn"
                title="Copy to clipboard"
                onClick={() => {
                  navigator.clipboard.writeText(bubbleText).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  })
                }}
              >
                <FontAwesomeIcon icon={copied ? faCheck : faCopy} />
              </button>
            )}
            {hasDelete && (
              <button
                className="action-btn action-btn--danger"
                title="Delete this branch"
                onClick={() => {
                  if (window.confirm('Delete this message and all replies? This cannot be undone.')) {
                    onDeleteBranch!(msg.msgId)
                  }
                }}
              >
                <FontAwesomeIcon icon={faTrash} />
              </button>
            )}
          </div>
        )
      })()}

    </div>
  )
})

export default MessageBubble
