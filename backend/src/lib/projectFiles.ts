import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import type { Block } from './llm/blocks'
import { converseOnce, type LlmCallContext } from './bedrock'
import { MEMORY_EXTRACTION_MODEL } from '../config/models'
import FILE_SUMMARY_SYSTEM from '../../prompts/file-summary.txt'

const BUCKET = process.env.ATTACHMENTS_BUCKET ?? ''
const s3 = new S3Client({})

export interface FileSummary {
  microLabel: string
  summary: string
  extractedTextKey?: string   // S3 key of .extracted.txt (PDF/text only)
}

/**
 * Summarize a project file using Bedrock.
 * Content type determines the strategy:
 *   - text/* / csv / md / octet-stream: read bytes from S3, send as text
 *   - image/*: send as image block (vision)
 *   - application/pdf: send as document block
 *   - other: return stub summary without a Bedrock call
 * Never throws — returns a best-effort result with a fallback on error.
 */
export async function summarizeFile(params: {
  s3Key: string
  contentType: string
  filename: string
  projectId?: string
}): Promise<FileSummary> {
  const { s3Key, contentType, filename, projectId } = params
  // Built once here and threaded down rather than assembled at the converseOnce call:
  // the per-format helpers are the only things between here and the model, and projectId
  // is what makes the emitted `llm_call` record correlate with the file's own log lines.
  const call: LlmCallContext = { purpose: 'file_summary', projectId }

  try {
    if (isTextLike(contentType)) {
      return await summarizeTextFile(s3Key, contentType, filename, call)
    }
    if (contentType.startsWith('image/')) {
      return await summarizeImageFile(s3Key, contentType, filename, call)
    }
    if (contentType === 'application/pdf') {
      return await summarizePdfFile(s3Key, filename, call)
    }
    // Binary/unknown — stub
    return {
      microLabel: `${filename} (binary)`,
      summary: 'Unsummarized binary file. Contents unknown.',
    }
  } catch (e) {
    console.error(JSON.stringify({ event: 'summarize_file_error', s3Key, contentType, error: String(e) }))
    return {
      microLabel: filename.slice(0, 60),
      summary: 'Summary generation failed.',
    }
  }
}

function isTextLike(contentType: string): boolean {
  return (
    contentType.startsWith('text/') ||
    contentType === 'application/octet-stream'
  )
}

export async function fetchS3Text(s3Key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }))
  const bytes = await (res.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray()
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

export async function fetchS3Bytes(s3Key: string): Promise<Uint8Array> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }))
  return (res.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray()
}

async function callSummaryModel(messages: Array<{ role: 'user'; content: Block[] }>, call: LlmCallContext): Promise<FileSummary> {
  const raw = await converseOnce(MEMORY_EXTRACTION_MODEL, FILE_SUMMARY_SYSTEM, messages, { maxTokens: 512, call })
  const cleaned = (raw ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  try {
    const parsed = JSON.parse(cleaned) as { microLabel?: unknown; summary?: unknown }
    const microLabel = typeof parsed.microLabel === 'string' && parsed.microLabel.trim()
      ? parsed.microLabel.trim()
      : 'File'
    const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : 'No summary available.'
    return { microLabel, summary }
  } catch {
    return { microLabel: 'File', summary: raw?.slice(0, 300) ?? 'No summary available.' }
  }
}

async function summarizeTextFile(s3Key: string, contentType: string, filename: string, call: LlmCallContext): Promise<FileSummary> {
  const fullText = await fetchS3Text(s3Key)
  // Cap at 8000 chars to protect context window
  const text = fullText.length > 8000 ? fullText.slice(0, 8000) + '\n\n[... truncated ...]' : fullText

  const result = await callSummaryModel([{
    role: 'user',
    content: [
      {
        kind: 'document',
        document: {
          format: contentType === 'text/csv' ? 'csv' : 'txt',
          name: filename.replace(/\.[^.]+$/, '').slice(0, 200) || 'file',
          source: { bytes: new TextEncoder().encode(text) },
        },
      },
      { kind: 'text', text: 'Analyze this file and produce the JSON summary.' },
    ],
  }], call)

  // Store the extracted text for L2 reads
  const extractedTextKey = `${s3Key}.extracted.txt`
  try {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: extractedTextKey,
      Body: fullText,
      ContentType: 'text/plain',
    }))
  } catch {
    // Non-fatal: L2 reads can fall back to the original object
  }

  return { ...result, extractedTextKey }
}

async function summarizeImageFile(s3Key: string, contentType: string, filename: string, call: LlmCallContext): Promise<FileSummary> {
  const bytes = await fetchS3Bytes(s3Key)
  const format = contentType.split('/')[1] as 'png' | 'jpeg' | 'gif' | 'webp'

  return callSummaryModel([{
    role: 'user',
    content: [
      { kind: 'image', image: { format, source: { bytes } } },
      { kind: 'text', text: `Filename: ${filename}` },
    ],
  }], call)
}

async function summarizePdfFile(s3Key: string, filename: string, call: LlmCallContext): Promise<FileSummary> {
  const bytes = await fetchS3Bytes(s3Key)
  const docName = filename.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9 \-()]/g, ' ').trim().slice(0, 200) || 'document'

  const result = await callSummaryModel([{
    role: 'user',
    content: [
      {
        kind: 'document',
        document: {
          format: 'pdf',
          name: docName,
          source: { bytes },
        },
      },
      { kind: 'text', text: 'Analyze this file and produce the JSON summary.' },
    ],
  }], call)

  return result  // No extractedTextKey for PDFs — L2 reads use original bytes
}
