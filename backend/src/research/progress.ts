import type { StreamChunk } from '../lib/llm/types'
import type { ResearchPhase, ResearchStep, RunContext } from './types'
import { notifyConnection } from '../lib/wsNotify'

// Why step-boundary frames rather than forwarding the token stream, and why steps are
// never persisted: docs/adr/0027-research-progress-as-step-boundary-frames.md

// A researcher's raw tool output (a fetched page, a search payload) can run to tens of KB.
// The progress pill only ever shows a preview of it, and the authoritative copy already
// reaches the user through the finding and the dossier — so the frame carries a preview
// rather than the whole body, keeping a wave of concurrent researchers from pushing
// megabytes through the WebSocket for text nobody reads.
const STEP_RESULT_PREVIEW = 2000

/**
 * Coarse "what is the run doing right now" signal. This is the honest granularity for the
 * states that call `converseOnce` (assess, report) — a single blocking call yields no
 * chunks at all, so there is nothing finer to report without inventing it.
 */
export async function notifyPhase(ctx: RunContext, phase: ResearchPhase, detail?: string): Promise<void> {
  await notifyConnection(ctx.connId, {
    type: 'research_phase',
    runId: ctx.runId,
    chatId: ctx.chatId,
    phase,
    ...(detail ? { detail } : {}),
  })
}

/** Push one already-shaped step. The frontend upserts tool steps by `toolUseId`. */
export async function notifyStep(ctx: RunContext, step: ResearchStep, subQuestionId?: string): Promise<void> {
  await notifyConnection(ctx.connId, {
    type: 'research_step',
    runId: ctx.runId,
    chatId: ctx.chatId,
    ...(subQuestionId ? { subQuestionId } : {}),
    step,
  })
}

/**
 * Bridges a `converseStream` loop to `research_step` frames — the one place StreamChunks
 * are translated, so recon/researcher don't each grow their own copy of this mapping.
 *
 * Deliberately *not* a token-level forward of the stream the way `ws/sendMessage.ts` does
 * it. A wave runs up to three researchers as separate concurrent Lambdas pushing to one
 * connection, so interleaved token deltas would need per-source reassembly on the client;
 * and a researcher's answer text is already delivered whole as its `research_finding`.
 * Frames are emitted at step boundaries instead: each one is self-contained and keyed, so
 * concurrent researchers need no coordination and a dropped frame costs one missing pill
 * rather than a corrupted stream.
 */
export function stepEmitter(ctx: RunContext, subQuestionId?: string): (chunk: StreamChunk) => Promise<void> {
  // Thinking arrives as a run of deltas with no chunk carrying the finished text, so it is
  // accumulated here and emitted once on thinking_done.
  let thinking = ''
  // A tool_result chunk carries no `name`/`input`, so in-flight calls are held here to
  // re-emit each step complete — the client upserts whole steps and never merges partials.
  const pending = new Map<string, { name: string; input: string }>()

  return async (chunk: StreamChunk) => {
    if (chunk.type === 'thinking_delta') {
      thinking += chunk.text
    } else if (chunk.type === 'thinking_done') {
      if (thinking.trim()) await notifyStep(ctx, { kind: 'thinking', text: thinking }, subQuestionId)
      thinking = ''
    } else if (chunk.type === 'tool_call') {
      pending.set(chunk.toolUseId, { name: chunk.name, input: chunk.input })
      await notifyStep(ctx, { kind: 'tool', toolUseId: chunk.toolUseId, name: chunk.name, input: chunk.input }, subQuestionId)
    } else if (chunk.type === 'tool_result') {
      const call = pending.get(chunk.toolUseId)
      pending.delete(chunk.toolUseId)
      await notifyStep(ctx, {
        kind: 'tool',
        toolUseId: chunk.toolUseId,
        name: chunk.name,
        input: call?.input ?? '{}',
        result: chunk.content.slice(0, STEP_RESULT_PREVIEW),
        isError: chunk.isError,
      }, subQuestionId)
    }
    // delta/heartbeat/stop/turn/usage carry nothing a progress pill shows.
  }
}
