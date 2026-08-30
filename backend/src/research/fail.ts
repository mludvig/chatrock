import type { FailInput, FailResult } from './types'
import { getRun, updateRun } from '../lib/dynamo'
import { notifyConnection } from '../lib/wsNotify'

// The terminal error handler every state's Catch routes to (terraform/research.tf's
// RunFailed). Without it a crashed run leaves its RUN# row on a non-terminal status
// forever: the panel spins on a run that no longer exists, and — worse — getActiveRun()
// keeps treating the chat as mid-run, so every subsequent message is swallowed as a
// steering note instead of being answered. See docs/adr/0035-a-failed-research-run-is-a-terminal-state.md.

// The user never sees the raw exception; it goes to CloudWatch. This is what the panel says.
const FAILURE_MESSAGE = 'The research run stopped unexpectedly. Nothing further will arrive — ask again to start a new one.'

export const handler = async (event: FailInput): Promise<FailResult> => {
  const cause = event.error?.Cause ?? event.error?.Error ?? 'unknown'
  console.log(JSON.stringify({
    event: 'research_run_failed', runId: event.runId, chatId: event.chatId,
    error: event.error?.Error, cause: cause.slice(0, 2000),
  }))

  // A run that already reached a terminal state is left alone — Report's own Catch can fire
  // after report.ts has persisted the answer and set status:'done' (the dossier write is the
  // one step that runs after that), and rewriting it to 'failed' would hide a report the
  // user already has.
  const run = await getRun(event.chatId, event.runId)
  if (run && (run.status === 'done' || run.status === 'failed')) return { failed: false }

  await updateRun(event.chatId, event.runId, { status: 'failed', failureReason: FAILURE_MESSAGE })
  await notifyConnection(run?.connId, {
    type: 'research_failed',
    runId: event.runId,
    chatId: event.chatId,
    message: FAILURE_MESSAGE,
  })
  return { failed: true }
}
