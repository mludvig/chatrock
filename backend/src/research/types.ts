// Shared shapes for the Deep Research Step Functions state machine
// (terraform/research.tf). Each Task state in the ASL invokes exactly one of the
// handlers in this directory with one of these Input types, and its return value
// becomes that state's Result — Step Functions passes JSON straight through, no
// wrapping needed. See docs/adr/0023-deep-research-step-functions-orchestration.md
// and backend/src/research/CLAUDE.md.

import type { AttachmentMeta } from '../lib/attachments'

export interface RunContext {
  chatId: string
  runId: string
  sub: string
  // The WS connection that started the run, threaded through every state so a handler can
  // push a best-effort progress frame (lib/wsNotify.ts) without a round-trip to the RUN# row.
  // Optional: a handler invoked without it (e.g. a stale/reconnected run) just skips the push.
  connId?: string
}

export interface SubQuestion {
  id: string
  question: string
}

// Live-progress wire shapes (progress.ts). Both are best-effort UI frames like every other
// research frame — never persisted, never replayed on reconnect; the RUN# row stays the
// source of truth. See CLAUDE.md's "Progress frames and reconnect".

/**
 * Which part of the run is currently working. There is deliberately no 'wave' member — a
 * wave already announces itself with research_wave_start, carrying the sub-questions the
 * status line needs.
 */
export type ResearchPhase = 'recon' | 'planning' | 'assessing' | 'reporting' | 'dossier'

/**
 * One thinking block or tool call from a research phase that runs a real `converseStream`
 * loop. Structurally a subset of the frontend's own `Step` union (frontend/src/api/http.ts),
 * so research progress renders through the same components a normal turn's steps do.
 */
export type ResearchStep =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolUseId: string; name: string; input: string; result?: string; isError?: boolean }

export interface ReconInput extends RunContext {
  question: string
}

export interface ReconResult {
  notes: string[]
}

// `recon` is set for the initial Plan (fresh from Recon's notes); `priorPlan`/`feedback` are
// set instead for a Replan (the user hit "Revise" — see researchApprove.ts/CLAUDE.md's
// "Plan approval gate"). plan.ts's handler branches on which pair is present.
export interface PlanInput extends RunContext {
  question: string
  recon?: ReconResult
  priorPlan?: PlanResult
  feedback?: string
}

export interface PlanResult {
  subQuestions: SubQuestion[]
  clarifyingQuestions: string[]
}

export interface AwaitApprovalInput extends RunContext {
  question: string
  plan: PlanResult
  taskToken: string
}

export interface Finding {
  subQuestionId: string
  summary: string
  sourceUrls: string[]
}

export interface ResearcherInput extends RunContext {
  subQuestion: SubQuestion
  steeringNotes: string[]
}

export interface ResearcherResult {
  finding: Finding
}

// One entry of the Wave Map state's raw per-item output (terraform/research.tf's
// research_wave_iterator merges each Researcher's ResultPath="$.result" into the item
// alongside the item's own subQuestion/steeringNotes fields — see CLAUDE.md's "Wave output
// shape").
export interface WaveFindingEntry {
  subQuestion: SubQuestion
  steeringNotes: string[]
  result: ResearcherResult
}

export interface AssessInput extends RunContext {
  question: string
  plan: PlanResult
  findings: Finding[]
  waveFindings: WaveFindingEntry[]
  gapsNotPursued: string[]
  steeringNotes: string[]
  roundsSpent: number
}

// Assess (terraform/research.tf) has ResultPath="$" — like AwaitApproval's SendTaskSuccess
// (see CLAUDE.md's "Plan approval gate"), the Task's Result entirely replaces the state
// machine's state, so this must carry every field Wave/Assess/Report need on the next
// hop, not just the assessment's own verdict.
export interface AssessResult extends RunContext {
  question: string
  plan: PlanResult
  findings: Finding[]
  nextSubQuestions: SubQuestion[]
  gapsNotPursued: string[]
  steeringNotes: string[]
  roundsSpent: number
  done: boolean
}

export interface ReportInput extends RunContext {
  question: string
  plan: PlanResult
  findings: Finding[]
  gapsNotPursued: string[]
}

export interface ReportResult {
  reportText: string
}

// Every state's Catch routes here (terraform/research.tf's RunFailed). `error` is what
// Step Functions merges in at ResultPath="$.error" — its own {Error, Cause} envelope, not
// anything a handler produced.
export interface FailInput {
  chatId: string
  runId: string
  error?: { Error?: string; Cause?: string }
}

export interface FailResult {
  // false when the row was already terminal and was left as it was — see fail.ts.
  failed: boolean
}

export type RunStatus = 'recon' | 'planning' | 'awaiting_approval' | 'running' | 'done' | 'failed'

// The PK=CHAT#<chatId> / SK=RUN#<runId> DynamoDB row — see backend/src/research/CLAUDE.md's
// "Data model" section. Built/read via lib/dynamo.ts's putRun/getRun/updateRun.
export interface RunRow {
  PK: string
  SK: string
  runId: string
  chatId: string
  sub: string
  status: RunStatus
  question: string
  // The chat's model at the moment the run started — every phase's LLM call uses it.
  // See docs/adr/0030-research-runs-use-the-chats-model.md.
  model: string
  // What the run knows about the person who asked: their memories, plus the project's
  // instructions/memories for a project chat. Snapshotted at startResearch, read back by
  // plan.ts. See docs/adr/0033-research-runs-see-the-users-memory.md.
  context?: string
  // Navigational file manifest + forced-inclusion file content for a project chat.
  // Snapshotted at startResearch, read back by plan.ts/report.ts. See
  // docs/adr/0038-research-runs-see-project-files.md.
  projectContext?: string
  // Refs to the question's attachments (images/documents), never bytes — snapshotted at
  // startResearch, read back by plan.ts/report.ts via resolveRunAttachmentBlocks. See
  // docs/adr/0034-research-runs-carry-the-questions-attachments.md.
  attachments?: AttachmentMeta[]
  plan?: PlanResult
  findings: Finding[]
  gapsNotPursued: string[]
  steeringNotes: string[]
  roundsSpent: number
  connId?: string
  taskToken?: string
  reportText?: string
  // Set with status:'failed' by fail.ts — what the panel shows for a run that crashed, so a
  // client that reconnects after the research_failed frame was missed still learns why.
  failureReason?: string
  createdAt: string
  updatedAt: string
}
