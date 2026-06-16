import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime'
import { converseOnce } from './bedrock'
import { MEMORY_EXTRACTION_MODEL } from '../config/models'

const BUCKET = process.env.ATTACHMENTS_BUCKET ?? ''
const s3 = new S3Client({})

export interface FileSummary {
  microLabel: string
  summary: string
  extractedTextKey?: string   // S3 key of .extracted.txt (PDF/text only)
}

const FILE_SUMMARY_SYSTEM = `You analyze files and produce a JSON object with exactly two fields:
- "microLabel": ≤10 words describing what this file IS (e.g. "Q3 sales report", "Python utility script", "Architecture diagram")
- "summary": a detailed-but-concise description (~150 words max) of the file's contents and structure — enough for a reader to decide whether to open the full file. Do NOT include conclusions or answers derived from the content; describe what IS in the file.

Output ONLY valid JSON, no markdown, no explanation.`

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
}): Promise<FileSummary> {
  const { s3Key, contentType, filename } = params

  try {
    if (isTextLike(contentType)) {
      return await summarizeTextFile(s3Key, contentType, filename)
    }
    if (contentType.startsWith('image/')) {
      return await summarizeImageFile(s3Key, contentType, filename)
    }
    if (contentType === 'application/pdf') {
      return await summarizePdfFile(s3Key, filename)
    }
    // Binary/unknown — stub
    return {
      microLabel: `${filename} (binary)`,
      summary: 'Unsummarized binary file. Contents unknown.',
    }
  } catch {
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

async function callSummaryModel(messages: Array<{ role: 'user'; content: ContentBlock[] }>): Promise<FileSummary> {
  const raw = await converseOnce(MEMORY_EXTRACTION_MODEL, FILE_SUMMARY_SYSTEM, messages, { maxTokens: 512 })
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

async function summarizeTextFile(s3Key: string, contentType: string, filename: string): Promise<FileSummary> {
  const fullText = await fetchS3Text(s3Key)
  // Cap at 8000 chars to protect context window
  const text = fullText.length > 8000 ? fullText.slice(0, 8000) + '\n\n[... truncated ...]' : fullText

  const result = await callSummaryModel([{
    role: 'user',
    content: [{
      document: {
        format: contentType === 'text/csv' ? 'csv' : 'txt',
        name: filename.replace(/\.[^.]+$/, '').slice(0, 200) || 'file',
        source: { bytes: new TextEncoder().encode(text) },
      },
    } as unknown as ContentBlock],
  }])

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

async function summarizeImageFile(s3Key: string, contentType: string, filename: string): Promise<FileSummary> {
  const bytes = await fetchS3Bytes(s3Key)
  const format = contentType.split('/')[1] as 'png' | 'jpeg' | 'gif' | 'webp'

  return callSummaryModel([{
    role: 'user',
    content: [
      { image: { format, source: { bytes } } } as unknown as ContentBlock,
      { text: `Filename: ${filename}` } as ContentBlock,
    ],
  }])
}

async function summarizePdfFile(s3Key: string, filename: string): Promise<FileSummary> {
  const bytes = await fetchS3Bytes(s3Key)
  const docName = filename.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9 \-()]/g, ' ').trim().slice(0, 200) || 'document'

  const result = await callSummaryModel([{
    role: 'user',
    content: [{
      document: {
        format: 'pdf',
        name: docName,
        source: { bytes },
      },
    } as unknown as ContentBlock],
  }])

  return result  // No extractedTextKey for PDFs — L2 reads use original bytes
}
