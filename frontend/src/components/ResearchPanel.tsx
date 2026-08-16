import { useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faMagnifyingGlass, faSpinner, faCheck, faPenToSquare } from '@fortawesome/free-solid-svg-icons'
import type { ActiveResearch } from '../store/chatStore'

// Deep Research's plan-approval + live-progress panel. Rendered by ChatView while a run is
// active for the current chat (cleared on research_done). No "Reject" action — a user who
// dislikes the plan just abandons the chat; the backend's 24h AwaitApproval timeout handles
// cleanup on its own (see backend/src/research/CLAUDE.md's "Plan approval gate").
export default function ResearchPanel({ run, onApprove, onRevise }: {
  run: ActiveResearch
  onApprove: (feedback?: string) => void
  onRevise: (feedback: string) => void
}) {
  const [feedback, setFeedback] = useState('')

  const trimmed = feedback.trim()

  function handleApprove() {
    onApprove(trimmed || undefined)
    setFeedback('')
  }

  function handleRevise() {
    if (!trimmed) return
    onRevise(trimmed)
    setFeedback('')
  }

  return (
    <div className="research-panel">
      <div className="research-panel-header">
        <FontAwesomeIcon icon={faMagnifyingGlass} />
        <span>Deep Research</span>
        <span className="research-panel-question">{run.question}</span>
      </div>

      {(run.status === 'recon' || run.status === 'planning') && (
        <div className="research-panel-status">
          <FontAwesomeIcon icon={faSpinner} spin /> Researching the question before proposing a plan…
        </div>
      )}

      {run.status === 'awaiting_approval' && run.plan && (
        <div className="research-panel-plan">
          {run.plan.clarifyingQuestions.length > 0 && (
            <div className="research-panel-section">
              <h4>Clarifying questions</h4>
              <ul>
                {run.plan.clarifyingQuestions.map((q, i) => <li key={i}>{q}</li>)}
              </ul>
            </div>
          )}
          <div className="research-panel-section">
            <h4>Proposed sub-questions</h4>
            <ul>
              {run.plan.subQuestions.map(sq => <li key={sq.id}>{sq.question}</li>)}
            </ul>
          </div>
          <textarea
            className="research-panel-feedback"
            placeholder="Optional feedback — e.g. &quot;Change point 2 to XYZ and also consider ABC&quot;. Leave blank and click Approve to start as-is, or add feedback and click Revise for an updated plan."
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
          />
          <div className="research-panel-actions">
            <button className="btn-primary" onClick={handleApprove}>
              <FontAwesomeIcon icon={faCheck} /> Approve
            </button>
            <button className="btn-secondary" onClick={handleRevise} disabled={!trimmed} title={trimmed ? undefined : 'Add feedback above to revise the plan'}>
              <FontAwesomeIcon icon={faPenToSquare} /> Revise
            </button>
          </div>
        </div>
      )}

      {run.status === 'running' && (
        <div className="research-panel-progress">
          <div className="research-panel-status">
            <FontAwesomeIcon icon={faSpinner} spin /> Researching {run.waveSubQuestions.length} sub-question{run.waveSubQuestions.length === 1 ? '' : 's'}…
          </div>
          {run.findings.length > 0 && (
            <ul className="research-panel-findings">
              {run.findings.map((f, i) => (
                <li key={`${f.subQuestionId}-${i}`}>
                  <FontAwesomeIcon icon={faCheck} /> {f.summary}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {run.status === 'failed' && (
        <div className="research-panel-status research-panel-status--error">
          The research run failed. You can start a new one from the composer.
        </div>
      )}
    </div>
  )
}
