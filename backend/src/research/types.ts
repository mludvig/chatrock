// Shared shapes for the Deep Research Step Functions state machine
// (terraform/research.tf). Each Task state in the ASL invokes exactly one of the
// handlers in this directory with one of these Input types, and its return value
// becomes that state's Result — Step Functions passes JSON straight through, no
// wrapping needed. See docs/adr/0023-deep-research-step-functions-orchestration.md.
//
// Filled in by later tasks: the RUN# DynamoDB row shape (backend/CLAUDE.md's data
// model section, task #9), and the real bodies of each handler (#10, #12, #13, #15).
// For now every handler in this directory is a stub that validates its input and
// returns a minimally-shaped stub result, so the state machine itself can be
// deployed and exercised end-to-end before the research logic exists.

export interface RunContext {
  chatId: string
  runId: string
  sub: string
}

export interface SubQuestion {
  id: string
  question: string
}

export interface ReconInput extends RunContext {
  question: string
}

export interface ReconResult {
  notes: string[]
}

export interface PlanInput extends RunContext {
  question: string
  recon: ReconResult
}

export interface PlanResult {
  subQuestions: SubQuestion[]
  clarifyingQuestions: string[]
}

export interface AwaitApprovalInput extends RunContext {
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

export interface AssessInput extends RunContext {
  question: string
  findings: Finding[]
  steeringNotes: string[]
  roundsSpent: number
}

export interface AssessResult {
  done: boolean
  nextSubQuestions: SubQuestion[]
  gapsNotPursued: string[]
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
