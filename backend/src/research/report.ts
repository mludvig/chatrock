import type { ReportInput, ReportResult } from './types'

// Step Functions Task state "Report" (terraform/research.tf) — synthesises the final,
// cited answer from every wave's findings and persists it as a normal assistant turn
// (task #15), then writes the full dossier as a project file (task #16). Stubbed for now.
export const handler = async (event: ReportInput): Promise<ReportResult> => {
  console.log(JSON.stringify({ event: 'research_report_start', runId: event.runId, chatId: event.chatId }))
  return { reportText: '' }
}
