// The research dossier: a completed run's full raw record (report + plan + findings +
// sources + gaps) rendered as a markdown project file. A run no longer creates a project
// to hold it — the dossier is written only when the chat already lives in one, either at
// report time (research/report.ts) or when the user later moves the chat into a project
// (http/chats.ts's PATCH projectId). See docs/adr/0031-deep-research-is-not-a-project.md.
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import type { PlanResult, Finding, RunRow } from '../research/types'
import { buildProjectFileKey, putProjectFile, listRuns, updateRun } from './dynamo'
import { projectFilePrefix } from './attachments'
import { summarizeFile } from './projectFiles'
import { newId } from './ids'

const BUCKET = process.env.ATTACHMENTS_BUCKET ?? ''
const s3 = new S3Client({})

export interface DossierContent {
  question: string
  plan: PlanResult
  findings: Finding[]
  gapsNotPursued: string[]
  reportText: string
}

// Writes the dossier as a project file and records on the RUN# row which project it landed
// in, so a chat moved between projects doesn't accumulate duplicate copies of the same run.
export async function writeResearchDossier(
  sub: string,
  runId: string,
  chatId: string,
  projectId: string,
  content: DossierContent,
): Promise<void> {
  const dossierText = buildDossierMarkdown(content)
  const fileId = newId()
  const filename = 'research-dossier.md'
  const s3Key = `${projectFilePrefix(sub, projectId)}${fileId}/${filename}`
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
  await updateRun(chatId, runId, { dossierProjectId: projectId })
  console.log(JSON.stringify({ event: 'research_dossier_written', runId, chatId, projectId, fileId }))
}

// Called when a chat is moved into a project (http/chats.ts's PATCH projectId): every
// completed run in that chat that hasn't already been filed there gets its dossier written,
// so the project gains the research record the run itself had nowhere to put.
export async function writeDossiersForChatMove(sub: string, chatId: string, projectId: string): Promise<void> {
  const runs = (await listRuns(chatId)) as unknown as RunRow[]
  for (const run of runs) {
    if (run.status !== 'done' || !run.reportText || !run.plan) continue
    if ((run as { dossierProjectId?: string }).dossierProjectId === projectId) continue
    await writeResearchDossier(sub, run.runId, chatId, projectId, {
      question: run.question,
      plan: run.plan,
      findings: run.findings ?? [],
      gapsNotPursued: run.gapsNotPursued ?? [],
      reportText: run.reportText,
    })
  }
}

// Assembled from what actually flows through the state machine today: the final report,
// the approved plan, the merged findings (source URLs included), and the gaps the
// supervisor chose not to pursue. The plan's dossier spec also asks for every wave's raw
// output and each individual supervisor assessment; ReportInput/RunRow don't carry that
// per-wave history (only the running-merged Finding[] — see AssessResult in types.ts), so
// this is the fuller record available without extending the run row to accumulate it.
export function buildDossierMarkdown(content: DossierContent): string {
  const lines: string[] = [
    `# Research dossier: ${content.question}`,
    '',
    '## Final report',
    '',
    content.reportText,
    '',
    '## Plan',
    '',
    ...(content.plan.clarifyingQuestions.length > 0
      ? ['**Clarifying questions:**', ...content.plan.clarifyingQuestions.map(q => `- ${q}`), '']
      : []),
    '**Sub-questions investigated:**',
    ...content.plan.subQuestions.map(sq => `- ${sq.question}`),
    '',
    '## Findings',
    '',
    ...content.findings.flatMap(f => [
      `### ${f.subQuestionId}`,
      '',
      f.summary,
      '',
      f.sourceUrls.length > 0 ? `Sources: ${f.sourceUrls.join(', ')}` : 'Sources: (none)',
      '',
    ]),
    '## Gaps not pursued',
    '',
    ...(content.gapsNotPursued.length > 0 ? content.gapsNotPursued.map(g => `- ${g}`) : ['(none)']),
  ]
  return lines.join('\n')
}
