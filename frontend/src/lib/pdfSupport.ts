// What to warn about when the selected model can't read PDFs.
// See docs/adr/0071-pdf-support-separate-from-text-documents.md.
import type { Message } from '../api/http'

export const PDF_CONTENT_TYPE = 'application/pdf'

/** PDFs attached to user messages on the loaded path; a model without PDF support sees only a note. */
export function countPdfAttachments(messages: Message[]): number {
  return messages.reduce((n, m) => n + (m.steps ?? []).filter(s => s.kind === 'attachment' && s.contentType === PDF_CONTENT_TYPE).length, 0)
}
