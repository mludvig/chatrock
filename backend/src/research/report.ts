import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import type { ReportInput, ReportResult } from './types'
import { converseOnce } from '../lib/bedrock'
import { DEFAULT_CHAT_MODEL } from '../config/models'
import {
  getChat, buildTurnKey, putMessage, updateChatActiveLeaf, updateRun,
  buildProjectKey, putProject, updateChatProject, buildProjectFileKey, putProjectFile,
} from '../lib/dynamo'
import { projectFilePrefix } from '../lib/attachments'
import { summarizeFile } from '../lib/projectFiles'
import { summarizeChatById, enrichProjectFactsByChatId } from '../lib/enrichment'
import { newId } from '../lib/ids'
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

  // Sensitive chats never get a project or a dossier file (docs/adr/0024) — findings stay
  // chat-scoped on the RUN# row, read back via the read_research_findings tool.
  const projectId = chat?.sensitive ? undefined : await writeDossier(event, reportText, chat)

  console.log(JSON.stringify({ event: 'research_report_done', runId: event.runId, chatId: event.chatId, msgId, projectId }))
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
): Promise<string> {
  let projectId = chat?.projectId as string | undefined
  if (!projectId) {
    projectId = newId()
    const now = new Date().toISOString()
    await putProject({
      ...buildProjectKey(event.sub, projectId),
      projectId,
      name: event.question.slice(0, 80),
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

  const summary = await summarizeFile({ s3Key, contentType: 'text/markdown', filename })
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

  return projectId
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
