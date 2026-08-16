// Shared shapes for the Deep Research Step Functions state machine
// (terraform/research.tf). Each Task state in the ASL invokes exactly one of the
// handlers in this directory with one of these Input types, and its return value
// becomes that state's Result — Step Functions passes JSON straight through, no
// wrapping needed. See docs/adr/0023-deep-research-step-functions-orchestration.md
// and backend/src/research/CLAUDE.md.
//
// Every handler in this directory is still a stub beyond persisting the RunRow — none
// of them call Bedrock yet.

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
  plan?: PlanResult
  findings: Finding[]
  gapsNotPursued: string[]
  steeringNotes: string[]
  roundsSpent: number
  connId?: string
  taskToken?: string
  createdAt: string
  updatedAt: string
}
