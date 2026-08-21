import { useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faMagnifyingGlass, faSpinner, faCheck, faPenToSquare } from '@fortawesome/free-solid-svg-icons'
import type { ActiveResearch } from '../store/chatStore'

// Feedback that doesn't change the plan — "OK", "looks good", etc. Anything else typed is
// treated as intent to revise. See docs/adr/0026-plan-approval-single-button.md.
const INCONSEQUENTIAL_FEEDBACK = /^(ok(ay)?|sounds? good|looks? good|good|fine|yes|yep|sure|approved?|go(\s*ahead)?|start|proceed|lgtm)[.!]?$/i

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
  // Disables the action button between a click and the run's next state change (a revised
  // plan, or status leaving awaiting_approval) — otherwise clearing feedback on submit flips
  // the button straight to "Approve" while the revise is still in flight, letting a second
  // click send a second decision on the same connection before the first's task token has
  // rotated. See backend/src/ws/researchApprove.ts's comment on the same race.
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setSubmitting(false)
  }, [run])

  const trimmed = feedback.trim()
  const isRevision = trimmed !== '' && !INCONSEQUENTIAL_FEEDBACK.test(trimmed)

  function handleSubmit() {
    setSubmitting(true)
    if (isRevision) {
      onRevise(trimmed)
    } else {
      onApprove(trimmed || undefined)
    }
    setFeedback('')
  }

  return (
    <div className="research-panel">
      {/* The question is already rendered as a normal user bubble directly above this
          panel (ChatView.tsx's optimistic user message), so it isn't repeated here. */}
      <div className="research-panel-header">
        <FontAwesomeIcon icon={faMagnifyingGlass} />
        <span>Deep Research</span>
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
            <h4>Proposed sub-questions <span className="research-panel-count">{run.plan.subQuestions.length}</span></h4>
            <ol>
              {run.plan.subQuestions.map(sq => <li key={sq.id}>{sq.question}</li>)}
            </ol>
          </div>
          <textarea
            className="research-panel-feedback"
            placeholder="Optional feedback — e.g. &quot;Change point 2 to XYZ and also consider ABC&quot;. Leave blank (or type OK) to start as-is; add feedback that changes the plan to revise it."
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
          />
          <div className="research-panel-actions">
            <button className="btn-primary" onClick={handleSubmit} disabled={submitting}>
              <FontAwesomeIcon icon={isRevision ? faPenToSquare : faCheck} /> {isRevision ? 'Revise' : 'Approve'}
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
