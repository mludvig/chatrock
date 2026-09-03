import type { ReportInput, ReportResult } from './types'
import { converseOnce } from '../lib/bedrock'
import {
  getChat, buildTurnKey, putMessage, updateChatActiveLeaf, updateChatTitle, updateRun,
  updateChatHasResearch,
} from '../lib/dynamo'
import { writeResearchDossier } from '../lib/researchDossier'
import { generateChatTitle } from '../lib/enrichment'
import { notifyConnection } from '../lib/wsNotify'
import { notifyPhase } from './progress'
import { linkifyReportCitations } from './citations'
import { resolveRunModel } from './model'
import { resolveRunProjectContext } from './context'
import { resolveRunAttachmentBlocks } from './attachments'
import { v4 as uuidv4 } from 'uuid'
import RESEARCH_REPORT_SYSTEM_PROMPT from '../../prompts/research-report.txt'

// Step Functions Task state "Report" (terraform/research.tf) — synthesises the final,
// cited answer from every wave's findings and persists it as a normal assistant turn,
// chained under the chat's current activeLeafId exactly like a normal ws/sendMessage.ts
// turn (so it renders identically in the transcript). A run never creates a project — the
// findings live on the RUN# row and are read back via the read_research_findings tool; a
// dossier file is written only when the chat is already in a project. See
// docs/adr/0031-deep-research-is-not-a-project.md.
export const handler = async (event: ReportInput): Promise<ReportResult> => {
  console.log(JSON.stringify({ event: 'research_report_start', runId: event.runId, chatId: event.chatId }))
  await notifyPhase(event, 'reporting')

  // Same project-file manifest/forced-file snapshot the planner sees, so the write-up can
  // draw on force-included file content. See docs/adr/0038-research-runs-see-project-files.md.
  const projectContext = await resolveRunProjectContext(event)

  const userMsg = [
    ...(projectContext ? [`PROJECT FILES:`, projectContext, ``] : []),
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

  // The question's own attachments (image/document), if any — so the write-up can
  // reference them. See docs/adr/0034-research-runs-carry-the-questions-attachments.md.
  const attachmentBlocks = await resolveRunAttachmentBlocks(event)

  const model = await resolveRunModel(event)
  const rawReportText = await converseOnce(model, RESEARCH_REPORT_SYSTEM_PROMPT, [
    { role: 'user', content: [...attachmentBlocks, { kind: 'text', text: userMsg }] },
  ], { maxTokens: 4096, call: { purpose: 'research_report', sub: event.sub, chatId: event.chatId, runId: event.runId } })
  // Deterministic rewrite of [n] markers and the Sources list into markdown links —
  // see citations.ts for why this isn't left to the model's own link syntax.
  const reportText = linkifyReportCitations(rawReportText)

  const chat = await getChat(event.sub, event.chatId)
  const ts = new Date().toISOString()
  const msgId = uuidv4()
  await putMessage({
    ...buildTurnKey(event.chatId, ts, 0, msgId),
    msgId,
    parentId: (chat?.activeLeafId as string | undefined) ?? null,
    role: 'assistant',
    blocks: [{ kind: 'text', text: reportText }],
    model,
    createdAt: ts,
    turnIndex: 0,
    responseId: uuidv4(),
  })
  await updateChatActiveLeaf(event.sub, event.chatId, msgId)
  await updateRun(event.chatId, event.runId, { status: 'done', reportText })
  await updateChatHasResearch(event.sub, event.chatId)

  // Deep Research bypasses ws/sendMessage.ts entirely, so its own title-gen path
  // (chat.title === 'New Chat' guard) never runs — do the same thing here.
  if (chat?.title === 'New Chat') {
    try {
      const title = await generateChatTitle(`User: ${event.question}\nAssistant: ${reportText}`, event.chatId)
      if (title) {
        await updateChatTitle(event.sub, event.chatId, title)
        await notifyConnection(event.connId, { type: 'titleUpdated', chatId: event.chatId, title })
      }
    } catch (err) {
      console.error(JSON.stringify({ event: 'research_title_gen_error', chatId: event.chatId, error: String(err) }))
    }
  }

  // A dossier file is written only when the chat already belongs to a project — the run
  // never creates one. Sensitive chats skip it entirely; their findings stay chat-scoped on
  // the RUN# row. See docs/adr/0031-deep-research-is-not-a-project.md.
  const projectId = chat?.projectId as string | undefined
  if (projectId && !chat?.sensitive) {
    // Its own phase: the dossier write summarizes the file, so it runs for a while after
    // the report itself is already in the transcript.
    await notifyPhase(event, 'dossier')
    await writeResearchDossier(event.sub, event.runId, event.chatId, projectId, {
      question: event.question,
      plan: event.plan,
      findings: event.findings,
      gapsNotPursued: event.gapsNotPursued,
      reportText,
    })
  }

  console.log(JSON.stringify({ event: 'research_report_done', runId: event.runId, chatId: event.chatId, msgId, projectId }))
  await notifyConnection(event.connId, {
    type: 'research_done', runId: event.runId, chatId: event.chatId, msgId,
  })
  return { reportText }
}
