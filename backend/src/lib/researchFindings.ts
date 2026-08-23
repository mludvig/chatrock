import { listRuns } from './dynamo'
import { capToolResultText } from './llm/blocks'
import type { ToolResult } from './llm/toolSpec'
import type { ToolContext } from './tools'
import type { Finding, PlanResult } from '../research/types'

function textResult(text: string, isError = false): ToolResult {
  return { entries: [{ kind: 'text', text }], isError }
}
function errorResult(text: string): ToolResult {
  return textResult(text, true)
}

// A completed run's findings live on the RUN# row, not in a project — this is how a chat
// reads its own Deep Research back, whether or not a dossier file was ever written.
// See docs/adr/0031-deep-research-is-not-a-project.md.
export async function executeReadResearchFindingsTool(
  input: Record<string, string>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.chatId) return errorResult('No chat context')

  const runs = await listRuns(ctx.chatId)
  const completed = runs
    .filter(r => r.status === 'done')
    .sort((a, b) => ((b.updatedAt as string) ?? '').localeCompare((a.updatedAt as string) ?? ''))
  const run = completed[0]
  if (!run) return errorResult('No completed Deep Research run found in this chat.')

  const question = run.question as string
  const plan = run.plan as PlanResult | undefined
  const findings = (run.findings as Finding[] | undefined) ?? []
  const gapsNotPursued = (run.gapsNotPursued as string[] | undefined) ?? []
  const reportText = (run.reportText as string | undefined) ?? ''

  if (input.detail === 'full') {
    const lines = [
      `Research question: ${question}`,
      '',
      'Final report:',
      reportText,
      '',
      'Sub-questions investigated:',
      ...(plan?.subQuestions.map(sq => `- ${sq.question}`) ?? []),
      '',
      'Findings:',
      ...findings.flatMap(f => [
        `- ${f.summary}`,
        f.sourceUrls.length > 0 ? `  Sources: ${f.sourceUrls.join(', ')}` : '  Sources: (none)',
      ]),
      '',
      'Gaps not pursued:',
      ...(gapsNotPursued.length > 0 ? gapsNotPursued.map(g => `- ${g}`) : ['(none)']),
    ].join('\n')
    return textResult(capToolResultText(lines))
  }

  const summary = [
    `Research question: ${question}`,
    '',
    'Final report:',
    reportText,
    '',
    'Gaps not pursued:',
    ...(gapsNotPursued.length > 0 ? gapsNotPursued.map(g => `- ${g}`) : ['(none)']),
  ].join('\n')
  return textResult(summary)
}
