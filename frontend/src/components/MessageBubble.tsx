import { useState, memo, forwardRef, Children, isValidElement } from 'react'
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
  faChevronLeft, faChevronRight, faGlobe, faSpinner, faLightbulb, faRotateRight, faPenToSquare,
  faCodeBranch, faCopy, faCheck, faTrash, faRobot, faCoins, faClock, faFile, faPlay,
  faAnglesUp,
} from '@fortawesome/free-solid-svg-icons'
import type { Message, Step, TokenUsage, ResearchDepth } from '../api/http'
import { useChatStore } from '../store/chatStore'
import type { StreamingMsg } from '../store/chatStore'
import { sanitizeUrl, ThinkingBlock, ToolCallPill } from './StepBlocks'

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
  // A "loose" list (blank line between items in the source markdown — common in LLM
  // output) wraps each item's content in a <p>. The hast tree's whitespace-only text
  // nodes around that <p> survive into React's children, forcing an anonymous block
  // before it — which pushes the ::marker onto its own line, visually separating "1."
  // from the item's text. Unwrap a lone <p> child so list items always render "tight".
  li({ children, ...props }: React.LiHTMLAttributes<HTMLLIElement>) {
    const kids = Children.toArray(children).filter(c => !(typeof c === 'string' && c.trim() === ''))
    if (kids.length === 1 && isValidElement<{ children?: React.ReactNode }>(kids[0]) && kids[0].type === 'p') {
      return <li {...props}>{kids[0].props.children}</li>
    }
    return <li {...props}>{children}</li>
  },
  // Raw <table> has no scroll container of its own — wrap it so a table too
  // wide even for the widened bubble (see .message-content:has(table)) scrolls
  // instead of overflowing the page.
  table({ children, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
    return (
      <div className="md-table-wrap">
        <table {...props}>{children}</table>
      </div>
    )
  },
  // Same treatment every other external link in this file already gets (sanitized,
  // opened in a new tab) — markdown links weren't going through that before, most
  // visibly the research report's citation links (report.ts's linkifyReportCitations).
  a({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
    return (
      <a href={sanitizeUrl(href ?? '')} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    )
  },
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
  onContinue?: (msgId: string) => void
  onEscalate?: (msgId: string, nextDepth: ResearchDepth) => void
  onNavigate?: (targetMsgId: string) => void
  onEditRequest?: (message: Message) => void
  onForkToHere?: (msgId: string, role: 'user' | 'assistant', text: string) => void
  onDeleteBranch?: (msgId: string) => void
  showTokenStats?: boolean
}

/**
 * Renders a chat bubble.  For StreamingMsg, steps may be in progress (last
 * thinking/text step still accumulating, tool result pending).  For Message,
 * all steps are final.
 *
 * Steps are rendered in arrival order — exactly as they appear in steps[].
 * This preserves the think → search → think → answer interleaved structure.
 */
const MessageBubble = memo(forwardRef<HTMLDivElement, Props>(function MessageBubble(
  { message, onRerun, onContinue, onEscalate, onNavigate, onEditRequest, onForkToHere, onDeleteBranch, showTokenStats }, ref,
) {
  const isAssistant = message.role === 'assistant'
  const isStreaming = 'streaming' in message && message.streaming
  const waiting = 'waiting' in message && message.waiting
  const idle = isStreaming && 'idle' in message && !!(message as StreamingMsg).idle
  const steps: Step[] = message.steps ?? []
  const [copied, setCopied] = useState(false)
  const { models } = useChatStore()

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
    <div ref={ref} className={`message ${message.role}`}>
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
              // Timestamp blocks injected by the backend — render as a muted label, not as chat text
              if (cleanStep.text.startsWith('Current timestamp: ')) {
                const isoStr = cleanStep.text.slice('Current timestamp: '.length)
                const displayTs = (() => {
                  try { return new Date(isoStr).toLocaleString() } catch { return isoStr }
                })()
                return (
                  <div key={i} className="msg-timestamp-label">{displayTs}</div>
                )
              }
              return (
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

        {/* Idle indicator — shown after 2s of no content events, once steps have started */}
        {idle && steps.length > 0 && (
          <span className="waiting-indicator">
            <FontAwesomeIcon icon={faSpinner} spin />
            <span>Processing…</span>
          </span>
        )}

      </div>

      {/* Per-message metadata line — assistant bubbles only, not streaming */}
      {isAssistant && !isStreaming && 'model' in message && (message as Message).createdAt && (() => {
        const msg = message as Message
        const modelShort = models.find(m => m.id === msg.model)?.name ?? msg.model
        const ts = new Date(msg.createdAt)
        const timeStr = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        const dateStr = ts.toLocaleDateString([], { month: 'short', day: 'numeric' })
        return (
          <div className="msg-meta">
            <span className="msg-meta-item">
              <FontAwesomeIcon icon={faRobot} />
              {modelShort}
            </span>
            {showTokenStats && msg.usage && (
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
                <FontAwesomeIcon icon={faLightbulb} />
                {msg.thinkingEffort}
              </span>
            )}
            {msg.webSearchEnabled === false && (
              <span className="msg-meta-item">
                <FontAwesomeIcon icon={faGlobe} />
                no web
              </span>
            )}
          </div>
        )
      })()}

      {/* Always-visible bottom row: sibling nav first, then action icons */}
      {!isStreaming && (() => {
        const hasSiblings = onNavigate && 'siblingCount' in message &&
          (message as Message).siblingCount != null &&
          (message as Message).siblingCount! > 1
        const hasEdit = !isAssistant && onEditRequest && 'msgId' in message
        const hasRerun = isAssistant && onRerun && 'parentId' in message && message.parentId != null
        const hasContinue = isAssistant && onContinue && 'msgId' in message &&
          !!((message as Message).errored || (message as Message).truncated)
        // Offered on any research-bearing answer below the top tier, not only truncated
        // ones — a turn can wrap up cleanly inside its budget and simply not dig deep enough.
        const escalateDepth: ResearchDepth | null =
          (message as Message).researchDepth === 'brief' ? 'extended'
          : (message as Message).researchDepth === 'extended' ? 'deep'
          : null
        const hasEscalate = isAssistant && onEscalate && 'msgId' in message && escalateDepth !== null &&
          ((message as Message).steps ?? []).some(s => s.kind === 'tool')
        const hasForkCopy = 'msgId' in message
        // A root message (parentId null) is only deletable when it has a sibling root to
        // fall back to — mirrors the backend's "sole root" guard in DELETE /messages/{msgId}.
        const hasDelete = onDeleteBranch && 'msgId' in message &&
          ((message as Message).parentId != null || ((message as Message).siblingCount ?? 0) > 1)
        if (!hasSiblings && !hasEdit && !hasRerun && !hasContinue && !hasEscalate && !hasForkCopy && !hasDelete) return null

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
                onClick={() => onEditRequest?.(message as Message)}
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
            {hasContinue && (
              <button
                className="action-btn"
                title={msg.truncated ? 'Continue research' : 'Continue this answer'}
                onClick={() => onContinue!(msg.msgId)}
              >
                <FontAwesomeIcon icon={faPlay} />
              </button>
            )}
            {hasEscalate && (
              <button
                className="action-btn"
                title={escalateDepth === 'deep' ? 'Escalate to Deep Research' : 'Go deeper (Extended)'}
                onClick={() => onEscalate!(msg.msgId, escalateDepth!)}
              >
                <FontAwesomeIcon icon={faAnglesUp} />
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
}))

export default MessageBubble
