import { useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faMagnifyingGlass, faSpinner, faCheck, faPenToSquare } from '@fortawesome/free-solid-svg-icons'
import type { ActiveResearch } from '../store/chatStore'
import type { Step } from '../api/http'
import { ThinkingBlock, ToolCallPill } from './StepBlocks'

// A run spends minutes between the frames that change its status, so each phase says what
// it is doing rather than leaving the same generic spinner up throughout.
const PHASE_LABEL: Record<NonNullable<ActiveResearch['phase']>, string> = {
  recon: 'Researching the question before proposing a plan…',
  planning: 'Drafting a research plan…',
  assessing: 'Reviewing the findings and deciding what is still missing…',
  reporting: 'Writing the final report…',
  dossier: 'Saving the research dossier…',
}

// Live steps render through the same components a normal turn's steps do (StepBlocks.tsx).
// A step only ever arrives complete, so `done`/`streaming` are fixed rather than tracked.
function StepList({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null
  return (
    <div className="research-panel-steps">
      {steps.map((s, i) =>
        s.kind === 'thinking' ? <ThinkingBlock key={i} text={s.text} done streaming={false} />
        : s.kind === 'tool' ? <ToolCallPill key={s.toolUseId} step={s} />
        : null
      )}
    </div>
  )
}

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

  const trimmed = feedback.trim()
  const isRevision = trimmed !== '' && !INCONSEQUENTIAL_FEEDBACK.test(trimmed)

  // ChatView moves the run out of awaiting_approval as it sends, so this whole block
  // unmounts on submit — no in-flight guard is needed to stop a second decision.
  function handleSubmit() {
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
        <>
          <StepList steps={run.reconSteps} />
          <div className="research-panel-status">
            <FontAwesomeIcon icon={faSpinner} spin /> {PHASE_LABEL[run.phase ?? 'recon']}
          </div>
        </>
      )}

      {run.status === 'awaiting_approval' && run.plan && (
        <div className="research-panel-plan">
          {/* How the run scoped the question — kept above the plan it produced. */}
          <StepList steps={run.reconSteps} />
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
            <button className="btn-primary" onClick={handleSubmit}>
              <FontAwesomeIcon icon={isRevision ? faPenToSquare : faCheck} /> {isRevision ? 'Revise' : 'Approve'}
            </button>
          </div>
        </div>
      )}

      {run.status === 'running' && (
        <div className="research-panel-progress">
          {/* Each researcher gets its own card so three concurrent ones don't interleave
              into one unattributable stream of pills. */}
          {run.waveSubQuestions.map(sq => {
            const finding = run.findings.find(f => f.subQuestionId === sq.id)
            return (
              <div className="research-panel-section research-panel-researcher" key={sq.id}>
                <h4>
                  <FontAwesomeIcon icon={finding ? faCheck : faSpinner} spin={!finding} />
                  {sq.question}
                </h4>
                <StepList steps={run.stepsBySubQuestion[sq.id] ?? []} />
                {finding && <div className="research-panel-finding">{finding.summary}</div>}
              </div>
            )
          })}
          {/* Findings from earlier waves — their researchers' steps belong to sub-questions
              this wave no longer lists, so only the result is carried forward. */}
          {run.findings.some(f => !run.waveSubQuestions.some(sq => sq.id === f.subQuestionId)) && (
            <ul className="research-panel-findings">
              {run.findings.filter(f => !run.waveSubQuestions.some(sq => sq.id === f.subQuestionId)).map((f, i) => (
                <li key={`${f.subQuestionId}-${i}`}>
                  <FontAwesomeIcon icon={faCheck} /> {f.summary}
                </li>
              ))}
            </ul>
          )}
          <div className="research-panel-status">
            <FontAwesomeIcon icon={faSpinner} spin />
            {' '}
            {run.phase && run.phase !== 'recon' && run.phase !== 'planning'
              ? PHASE_LABEL[run.phase]
              : `Researching ${run.waveSubQuestions.length} sub-question${run.waveSubQuestions.length === 1 ? '' : 's'}…`}
          </div>
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
