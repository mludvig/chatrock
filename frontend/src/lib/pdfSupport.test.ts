import { describe, expect, it } from 'vitest'
import { countPdfAttachments } from './pdfSupport'
import type { Message, Step } from '../api/http'

const attachment = (contentType: string, filename: string): Step =>
  ({ kind: 'attachment', attachmentKind: contentType.startsWith('image/') ? 'image' : 'document', filename, contentType, url: 'u', s3Key: 'k' })
const message = (steps: Step[]): Message => ({ msgId: 'm', role: 'user', steps, model: 'x', createdAt: '' })

describe('countPdfAttachments', () => {
  it('counts only PDF attachment steps, across messages', () => {
    expect(countPdfAttachments([
      message([attachment('application/pdf', 'a.pdf'), attachment('text/plain', 'b.txt'), { kind: 'text', text: 'hi' }]),
      message([attachment('image/png', 'c.png'), attachment('application/pdf', 'd.pdf')]),
    ])).toBe(2)
  })

  it('is zero for a chat without PDFs', () => {
    expect(countPdfAttachments([message([{ kind: 'text', text: 'hi' }])])).toBe(0)
  })
})
