import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import type { ReportInput, ReportResult } from './types'
import { converseOnce } from '../lib/bedrock'
import {
  getChat, buildTurnKey, putMessage, updateChatActiveLeaf, updateChatTitle, updateRun,
  buildProjectKey, putProject, updateChatProject, buildProjectFileKey, putProjectFile,
} from '../lib/dynamo'
import { projectFilePrefix } from '../lib/attachments'
import { summarizeFile } from '../lib/projectFiles'
import { summarizeChatById, enrichProjectFactsByChatId, generateChatTitle } from '../lib/enrichment'
import { newId } from '../lib/ids'
import { notifyConnection } from '../lib/wsNotify'
import { notifyPhase } from './progress'
import { linkifyReportCitations } from './citations'
import { resolveRunModel } from './model'
import { v4 as uuidv4 } from 'uuid'
import RESEARCH_REPORT_SYSTEM_PROMPT from '../../prompts/research-report.txt'

const BUCKET = process.env.ATTACHMENTS_BUCKET ?? ''
const s3 = new S3Client({})

// Step Functions Task state "Report" (terraform/research.tf) — synthesises the final,
// cited answer from every wave's findings and persists it as a normal assistant turn,
// chained under the chat's current activeLeafId exactly like a normal ws/sendMessage.ts
// turn (so it renders identically in the transcript). Then writes the dossier — see
// docs/adr/0024-research-dossier-as-a-project-file.md and buildDossierMarkdown() below.
// Sensitive chats skip the dossier entirely — findings stay chat-scoped and are read
// back via the read_research_findings tool. See docs/adr/0024.
export const handler = async (event: ReportInput): Promise<ReportResult> => {
  console.log(JSON.stringify({ event: 'research_report_start', runId: event.runId, chatId: event.chatId }))
  await notifyPhase(event, 'reporting')

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

  const model = await resolveRunModel(event)
  const rawReportText = await converseOnce(model, RESEARCH_REPORT_SYSTEM_PROMPT, [
    { role: 'user', content: [{ kind: 'text', text: userMsg }] },
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

  // Deep Research bypasses ws/sendMessage.ts entirely, so its own title-gen path
  // (chat.title === 'New Chat' guard) never runs — do the same thing here. The same
  // generated title is reused as the auto-created project's name below rather than the
  // raw (often long) question, so ChatDetailsDialog / dropdowns stay a sane width.
  let title: string | undefined
  if (chat?.title === 'New Chat') {
    try {
      title = await generateChatTitle(`User: ${event.question}\nAssistant: ${reportText}`, event.chatId)
      if (title) {
        await updateChatTitle(event.sub, event.chatId, title)
        await notifyConnection(event.connId, { type: 'titleUpdated', chatId: event.chatId, title })
      }
    } catch (err) {
      console.error(JSON.stringify({ event: 'research_title_gen_error', chatId: event.chatId, error: String(err) }))
    }
  }

  // Sensitive chats never get a project or a dossier file (docs/adr/0024) — findings stay
  // chat-scoped on the RUN# row, read back via the read_research_findings tool.
  let projectId: string | undefined
  let newProjectName: string | undefined
  if (!chat?.sensitive) {
    // Its own phase: writeDossier summarizes the file and backfills chat/project facts, so
    // it runs for a while after the report itself is already written.
    await notifyPhase(event, 'dossier')
    const dossier = await writeDossier(event, reportText, chat, title)
    projectId = dossier.projectId
    newProjectName = dossier.createdNew ? dossier.projectName : undefined
  }

  console.log(JSON.stringify({ event: 'research_report_done', runId: event.runId, chatId: event.chatId, msgId, projectId }))
  // newProjectName is set only when this run just created the project — the chat moving
  // there is a surprising side effect (it drops out of the LHS chat list's default filter),
  // so the frontend uses this to show a toast pointing at where it went. An existing
  // project's dossier write is unsurprising (the chat was already there) and gets no toast.
  await notifyConnection(event.connId, {
    type: 'research_done', runId: event.runId, chatId: event.chatId, msgId, projectId, newProjectName,
  })
  return { reportText }
}

// Every Deep Research run keeps its raw findings as a project file — see
// docs/adr/0024-research-dossier-as-a-project-file.md. If the chat isn't already in a
// project, one is created from the research topic and the chat is moved into it (the same
// projectId write + summarizeChatById/enrichProjectFactsByChatId backfill
// http/chats.ts's PATCH projectId path does for a user-initiated move).
async function writeDossier(
  event: ReportInput,
  reportText: string,
  chat: Record<string, unknown> | undefined,
  generatedTitle: string | undefined,
): Promise<{ projectId: string; createdNew: boolean; projectName: string }> {
  let projectId = chat?.projectId as string | undefined
  let projectName = ''
  const createdNew = !projectId
  if (!projectId) {
    projectId = newId()
    // The same title generated for the chat above (or, if title-gen failed / the chat
    // already had a real title, the raw question truncated) — reusing it here is what
    // keeps the auto-created project's name short instead of the full question text.
    projectName = generatedTitle ?? event.question.slice(0, 80)
    const now = new Date().toISOString()
    await putProject({
      ...buildProjectKey(event.sub, projectId),
      projectId,
      name: projectName,
      description: '',
      instructions: '',
      memoryEnabled: true,
      createdAt: now,
      updatedAt: now,
    })
    await updateChatProject(event.sub, event.chatId, projectId)
    await summarizeChatById(event.sub, event.chatId)
    await enrichProjectFactsByChatId(event.chatId, projectId)
    console.log(JSON.stringify({ event: 'research_dossier_project_created', runId: event.runId, chatId: event.chatId, projectId }))
  }

  const dossierText = buildDossierMarkdown(event, reportText)
  const fileId = newId()
  const filename = 'research-dossier.md'
  const s3Key = `${projectFilePrefix(event.sub, projectId)}${fileId}/${filename}`
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, Body: dossierText, ContentType: 'text/markdown' }))

  const summary = await summarizeFile({ s3Key, contentType: 'text/markdown', filename, projectId })
  const now = new Date().toISOString()
  await putProjectFile({
    ...buildProjectFileKey(projectId, fileId),
    fileId,
    filename,
    contentType: 'text/markdown',
    sizeBytes: Buffer.byteLength(dossierText, 'utf-8'),
    s3Key,
    status: 'ready',
    inclusion: 'auto',
    microLabel: summary.microLabel,
    summary: summary.summary,
    ...(summary.extractedTextKey ? { extractedTextKey: summary.extractedTextKey } : {}),
    createdAt: now,
    updatedAt: now,
  })

  return { projectId, createdNew, projectName }
}

// Assembled from what actually flows through the state machine today: the final report,
// the approved plan, the merged findings (source URLs included), and the gaps the
// supervisor chose not to pursue. The plan's dossier spec also asks for every wave's raw
// output and each individual supervisor assessment; ReportInput/RunRow don't carry that
// per-wave history (only the running-merged Finding[] — see AssessResult in types.ts), so
// this is the fuller record available without extending the run row to accumulate it.
function buildDossierMarkdown(event: ReportInput, reportText: string): string {
  const lines: string[] = [
    `# Research dossier: ${event.question}`,
    '',
    '## Final report',
    '',
    reportText,
    '',
    '## Plan',
    '',
    ...(event.plan.clarifyingQuestions.length > 0
      ? ['**Clarifying questions:**', ...event.plan.clarifyingQuestions.map(q => `- ${q}`), '']
      : []),
    '**Sub-questions investigated:**',
    ...event.plan.subQuestions.map(sq => `- ${sq.question}`),
    '',
    '## Findings',
    '',
    ...event.findings.flatMap(f => [
      `### ${f.subQuestionId}`,
      '',
      f.summary,
      '',
      f.sourceUrls.length > 0 ? `Sources: ${f.sourceUrls.join(', ')}` : 'Sources: (none)',
      '',
    ]),
    '## Gaps not pursued',
    '',
    ...(event.gapsNotPursued.length > 0 ? event.gapsNotPursued.map(g => `- ${g}`) : ['(none)']),
  ]
  return lines.join('\n')
}
