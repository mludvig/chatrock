import type { AssessInput, AssessResult, Finding, SubQuestion } from './types'
import { converseOnce } from '../lib/bedrock'
import { DEFAULT_CHAT_MODEL } from '../config/models'
import { safeParse } from '../lib/enrichment'
import { newId } from '../lib/ids'
import { updateRun } from '../lib/dynamo'
import { notifyConnection } from '../lib/wsNotify'
import { notifyPhase } from './progress'
import RESEARCH_ASSESS_SYSTEM_PROMPT from '../../prompts/research-assess.txt'

interface RawSubQuestion {
  id?: unknown
  question?: unknown
}

// Step Functions Task state "Assess" (terraform/research.tf) — has no Parameters
// mapping and ResultPath="$", so this handler's return value entirely replaces the state
// machine's state (see types.ts's AssessResult and CLAUDE.md's "Plan approval gate" for the
// same pattern). It flattens this wave's raw Map output into Finding[], merges it into the
// running total, and decides whether another wave is needed.
export const handler = async (event: AssessInput): Promise<AssessResult> => {
  console.log(JSON.stringify({ event: 'research_assess_start', runId: event.runId, chatId: event.chatId, roundsSpent: event.roundsSpent }))
  await notifyPhase(event, 'assessing')

  const newFindings: Finding[] = event.waveFindings.map(item => item.result.finding)
  const findings = [...event.findings, ...newFindings]

  const userMsg = [
    `QUESTION: ${event.question}`,
    ``,
    `FINDINGS SO FAR:`,
    findings.length > 0 ? findings.map(f => `- [${f.subQuestionId}] ${f.summary}`).join('\n') : '(none)',
    ``,
    `STEERING NOTES FROM USER:`,
    event.steeringNotes.length > 0 ? event.steeringNotes.join('\n') : '(none)',
  ].join('\n')

  const response = await converseOnce(DEFAULT_CHAT_MODEL, RESEARCH_ASSESS_SYSTEM_PROMPT, [
    { role: 'user', content: [{ kind: 'text', text: userMsg }] },
  ], { maxTokens: 1024 })

  const obj = safeParse(response)
  if (!obj) {
    console.error(JSON.stringify({ event: 'research_assess_parse_error', runId: event.runId, chatId: event.chatId, response: response?.slice(0, 500) }))
    const roundsSpent = event.roundsSpent + 1
    await updateRun(event.chatId, event.runId, { findings, gapsNotPursued: event.gapsNotPursued, roundsSpent })
    await notifyConnection(event.connId, { type: 'research_assess', runId: event.runId, chatId: event.chatId, findingCount: findings.length, done: true })
    return {
      chatId: event.chatId,
      runId: event.runId,
      sub: event.sub,
      question: event.question,
      plan: event.plan,
      findings,
      nextSubQuestions: [],
      gapsNotPursued: event.gapsNotPursued,
      steeringNotes: [],
      roundsSpent,
      done: true,
      connId: event.connId,
    }
  }

  const seenIds = new Set<string>()
  const rawSubQuestions = Array.isArray(obj.nextSubQuestions) ? (obj.nextSubQuestions as RawSubQuestion[]) : []
  const nextSubQuestions: SubQuestion[] = rawSubQuestions
    .filter((sq): sq is { id?: unknown; question: string } => typeof sq.question === 'string' && sq.question.trim().length > 0)
    .map(sq => {
      let id = typeof sq.id === 'string' && sq.id.trim() ? sq.id.trim() : newId()
      if (seenIds.has(id)) id = newId()
      seenIds.add(id)
      return { id, question: sq.question.trim() }
    })

  const gapsNotPursued = Array.isArray(obj.gapsNotPursued)
    ? obj.gapsNotPursued.filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
    : []

  const done = obj.done === true || nextSubQuestions.length === 0
  const roundsSpent = event.roundsSpent + 1
  const mergedGaps = [...event.gapsNotPursued, ...gapsNotPursued]

  console.log(JSON.stringify({ event: 'research_assess_done', runId: event.runId, chatId: event.chatId, done, nextSubQuestionCount: nextSubQuestions.length, findingCount: findings.length }))

  // Live progress for the re-sync endpoint (GET /api/chats/{chatId}/research) — the RUN#
  // row otherwise only gets written at awaitApproval.ts (first write) and report.ts
  // (terminal), leaving every intermediate wave invisible to a client that reconnects
  // mid-run.
  await updateRun(event.chatId, event.runId, { findings, gapsNotPursued: mergedGaps, roundsSpent })
  await notifyConnection(event.connId, { type: 'research_assess', runId: event.runId, chatId: event.chatId, findingCount: findings.length, done })
  if (!done) {
    await notifyConnection(event.connId, { type: 'research_wave_start', runId: event.runId, chatId: event.chatId, subQuestions: nextSubQuestions })
  }

  return {
    chatId: event.chatId,
    runId: event.runId,
    sub: event.sub,
    question: event.question,
    plan: event.plan,
    findings,
    nextSubQuestions,
    gapsNotPursued: mergedGaps,
    steeringNotes: [],
    roundsSpent,
    done,
    connId: event.connId,
  }
}
