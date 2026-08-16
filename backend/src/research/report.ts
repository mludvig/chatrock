import type { ReportInput, ReportResult } from './types'
import { converseOnce } from '../lib/bedrock'
import { DEFAULT_CHAT_MODEL } from '../config/models'
import { getChat, buildTurnKey, putMessage, updateChatActiveLeaf, updateRun } from '../lib/dynamo'
import { v4 as uuidv4 } from 'uuid'
import RESEARCH_REPORT_SYSTEM_PROMPT from '../../prompts/research-report.txt'

// Step Functions Task state "Report" (terraform/research.tf) — synthesises the final,
// cited answer from every wave's findings and persists it as a normal assistant turn,
// chained under the chat's current activeLeafId exactly like a normal ws/sendMessage.ts
// turn (so it renders identically in the transcript). The dossier project-file write is
// task #16, not here.
export const handler = async (event: ReportInput): Promise<ReportResult> => {
  console.log(JSON.stringify({ event: 'research_report_start', runId: event.runId, chatId: event.chatId }))

  const userMsg = [
    `QUESTION: ${event.question}`,
    ``,
    `FINDINGS:`,
    event.findings.length > 0
      ? event.findings.map(f => `- [${f.subQuestionId}] ${f.summary}\n  Sources: ${f.sourceUrls.join(', ') || '(none)'}`).join('\n')
      : '(none)',
    ``,
    `GAPS NOT PURSUED:`,
    event.gapsNotPursued.length > 0 ? event.gapsNotPursued.join('\n') : '(none)',
  ].join('\n')

  const reportText = await converseOnce(DEFAULT_CHAT_MODEL, RESEARCH_REPORT_SYSTEM_PROMPT, [
    { role: 'user', content: [{ kind: 'text', text: userMsg }] },
  ])

  const chat = await getChat(event.sub, event.chatId)
  const ts = new Date().toISOString()
  const msgId = uuidv4()
  await putMessage({
    ...buildTurnKey(event.chatId, ts, 0, msgId),
    msgId,
    parentId: (chat?.activeLeafId as string | undefined) ?? null,
    role: 'assistant',
    blocks: [{ kind: 'text', text: reportText }],
    model: DEFAULT_CHAT_MODEL,
    createdAt: ts,
    turnIndex: 0,
    responseId: uuidv4(),
  })
  await updateChatActiveLeaf(event.sub, event.chatId, msgId)
  await updateRun(event.chatId, event.runId, { status: 'done', reportText })

  console.log(JSON.stringify({ event: 'research_report_done', runId: event.runId, chatId: event.chatId, msgId }))
  return { reportText }
}
