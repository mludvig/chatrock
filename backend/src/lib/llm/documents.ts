// Fitting document blocks to what a model can read: PDFs need native support, text
// documents can always be sent as plain text. See docs/adr/0071-pdf-support-separate-from-text-documents.md.

import type { Block, DocumentRef, MediaSource, NeutralMessage, ToolResultEntry } from './blocks'

function sourceText(source: MediaSource): string {
  if ('bytes' in source) return Buffer.from(source.bytes).toString('utf8')
  return `[document at ${source.s3Uri} — not hydrated]`
}

/** A text document (txt/md/csv) as one plain-text payload. */
export function textDocument(doc: DocumentRef): string {
  return `<document name="${doc.name}">\n${sourceText(doc.source)}\n</document>`
}

function pdfOmitted(doc: DocumentRef): string {
  return `[PDF "${doc.name}" omitted: this model can't read PDFs]`
}

/**
 * Rewrites document blocks (top-level and inside tool results) for a model without PDF
 * support: each PDF becomes a short note, and with `inlineText` each text document becomes
 * a text block. Anything else passes through unchanged.
 */
export function adaptDocuments(messages: NeutralMessage[], opts: { pdf: boolean; inlineText: boolean }): NeutralMessage[] {
  if (opts.pdf) return messages
  const asText = (doc: DocumentRef): string | undefined =>
    doc.format === 'pdf' ? pdfOmitted(doc) : opts.inlineText ? textDocument(doc) : undefined
  const entry = (e: ToolResultEntry): ToolResultEntry => {
    const text = e.kind === 'document' ? asText(e.document) : undefined
    return text === undefined ? e : { kind: 'text', text }
  }
  const block = (b: Block): Block => {
    if (b.kind === 'document') {
      const text = asText(b.document)
      return text === undefined ? b : { kind: 'text', text }
    }
    if (b.kind === 'tool_result') return { ...b, entries: b.entries.map(entry) }
    return b
  }
  return messages.map(m => ({ ...m, content: m.content.map(block) }))
}
