import type { LlmCallContext, TokenUsage } from './types'

// The single place an `llm_call` CloudWatch record is written. Only lib/llm/loop.ts calls
// this — every LLM call in the backend goes through converseStream/converseOnce, so nothing
// else has to remember to log, and every purpose gets identical fields.
// See docs/adr/0029-llm-observability-in-the-wrapper.md.

export interface LlmCallRecord {
  call: LlmCallContext
  modelId: string
  provider: string
  // Date.now() taken just before the provider call, so durationMs measures the model, not
  // the surrounding handler.
  startedAt: number
  // Summed across every agentic round of the invocation, not just the last one — the
  // per-round figure understates a tool-heavy turn by an order of magnitude.
  usage?: TokenUsage
  rounds?: number
  stopReason?: string
  error?: unknown
}

export function logLlmCall(rec: LlmCallRecord): void {
  const { call, usage } = rec
  const line = {
    event: 'llm_call',
    purpose: call.purpose,
    model: rec.modelId,
    provider: rec.provider,
    ok: !rec.error,
    durationMs: Date.now() - rec.startedAt,
    ...(call.sub ? { sub: call.sub } : {}),
    ...(call.chatId ? { chatId: call.chatId } : {}),
    ...(call.projectId ? { projectId: call.projectId } : {}),
    ...(call.runId ? { runId: call.runId } : {}),
    ...(rec.rounds !== undefined ? { rounds: rec.rounds } : {}),
    ...(rec.stopReason ? { stopReason: rec.stopReason } : {}),
    ...(usage ? {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: usage.cacheReadInputTokens } : {}),
      ...(usage.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: usage.cacheWriteInputTokens } : {}),
    } : {}),
    ...(rec.error ? { error: String(rec.error) } : {}),
  }
  // Same event either way so one Insights query covers both; `ok` is the discriminator.
  if (rec.error) console.error(JSON.stringify(line))
  else console.log(JSON.stringify(line))
}

// Accumulate a round's usage into the invocation total. Cache counters stay optional —
// a provider that reports none must not start reporting a spurious 0.
export function addUsage(total: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (!next) return total
  if (!total) return { ...next }
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    ...(total.cacheReadInputTokens !== undefined || next.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: (total.cacheReadInputTokens ?? 0) + (next.cacheReadInputTokens ?? 0) } : {}),
    ...(total.cacheWriteInputTokens !== undefined || next.cacheWriteInputTokens !== undefined
      ? { cacheWriteInputTokens: (total.cacheWriteInputTokens ?? 0) + (next.cacheWriteInputTokens ?? 0) } : {}),
  }
}
