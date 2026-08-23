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

      {run.status === 'awaiting_approval' && (
        <div className="research-panel-plan">
          {/* How the run scoped the question — kept above the plan it produced. */}
          <StepList steps={run.reconSteps} />
          {/* The plan itself is rendered above, as the persisted assistant turn
              awaitApproval.ts wrote — so it stays in the transcript after approval instead
              of vanishing with this panel, and a revised plan lands beneath the feedback
              that asked for it. No feedback box here either: the panel scrolls off small
              screens while the main composer stays put, so answers went there and were
              swallowed. See docs/adr/0032-plan-feedback-classified-by-a-tiny-model.md. */}
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

      {(run.status === 'running' || run.status === 'done') && (
        <div className="research-panel-progress">
          {/* Each researcher gets its own card so three concurrent ones don't interleave
              into one unattributable stream of pills. Every wave's researchers stay listed
              — a finished one is the record of work done, and removing it as the next wave
              starts reads as progress being lost. */}
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
          {/* A finding whose sub-question isn't listed can only come from a re-synced run
              that missed its research_wave_start — still shown, just without its steps. */}
          {run.findings.some(f => !run.waveSubQuestions.some(sq => sq.id === f.subQuestionId)) && (
            <ul className="research-panel-findings">
              {run.findings.filter(f => !run.waveSubQuestions.some(sq => sq.id === f.subQuestionId)).map((f, i) => (
                <li key={`${f.subQuestionId}-${i}`}>
                  <FontAwesomeIcon icon={faCheck} /> {f.summary}
                </li>
              ))}
            </ul>
          )}
          {run.status === 'done' ? (
            <div className="research-panel-status">
              <FontAwesomeIcon icon={faCheck} /> Research complete — {run.findings.length} finding{run.findings.length === 1 ? '' : 's'}. The report is above.
            </div>
          ) : (
            <div className="research-panel-status">
              <FontAwesomeIcon icon={faSpinner} spin />
              {' '}
              {run.phase && run.phase !== 'recon' && run.phase !== 'planning'
                ? PHASE_LABEL[run.phase]
                : `Researching ${run.waveSubQuestions.length} sub-question${run.waveSubQuestions.length === 1 ? '' : 's'}…`}
            </div>
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
