import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faMagnifyingGlass, faSpinner, faCheck } from '@fortawesome/free-solid-svg-icons'
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

// Deep Research's plan-approval + live-progress panel. Rendered by ChatView while a run is
// active for the current chat (cleared on research_done). No "Reject" action — a user who
// dislikes the plan just abandons the chat; the backend's 24h AwaitApproval timeout handles
// cleanup on its own (see backend/src/research/CLAUDE.md's "Plan approval gate").
export default function ResearchPanel({ run, onApprove }: {
  run: ActiveResearch
  onApprove: () => void
}) {
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
              {/* Numbered so feedback can address one of them as "#2" — the Replan prompt
                  is given the same numbering (backend/src/research/plan.ts). */}
              <ol>
                {run.plan.clarifyingQuestions.map((q, i) => <li key={i}>{q}</li>)}
              </ol>
            </div>
          )}
          <div className="research-panel-section">
            <h4>Proposed sub-questions <span className="research-panel-count">{run.plan.subQuestions.length}</span></h4>
            <ol>
              {run.plan.subQuestions.map(sq => <li key={sq.id}>{sq.question}</li>)}
            </ol>
          </div>
          {/* No feedback box here: the panel scrolls off small screens while the main
              composer stays put, so answers went there and were swallowed. The composer is
              now the one input for the plan too — this button is just the shortcut for the
              common "start as-is". See docs/adr/0032-plan-feedback-classified-by-a-tiny-model.md. */}
          <div className="research-panel-actions">
            <button className="btn-primary" onClick={onApprove}>
              <FontAwesomeIcon icon={faCheck} /> Approve &amp; start
            </button>
            <span className="research-panel-hint">
              or reply below to answer a question or change the plan
            </span>
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
