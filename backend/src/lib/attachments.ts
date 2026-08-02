import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectsCommand, CopyObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { getSignedUrl as s3GetSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getSignedUrl as cfGetSignedUrl } from '@aws-sdk/cloudfront-signer'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import type { Block, DocumentFormat, ImageFormat } from './llm/blocks'

// ── Allowlist ─────────────────────────────────────────────────────────────────

interface AllowedType {
  kind: 'image' | 'document'
  format: string
  maxBytes: number
}

const DOCUMENT_MAX_BYTES = 1 * 1024 * 1024

const ALLOWED: Record<string, AllowedType> = {
  'image/png':                { kind: 'image',    format: 'png',  maxBytes: 5 * 1024 * 1024 },
  'image/jpeg':               { kind: 'image',    format: 'jpeg', maxBytes: 5 * 1024 * 1024 },
  'image/gif':                { kind: 'image',    format: 'gif',  maxBytes: 5 * 1024 * 1024 },
  'image/webp':               { kind: 'image',    format: 'webp', maxBytes: 5 * 1024 * 1024 },
  'application/pdf':          { kind: 'document', format: 'pdf',  maxBytes: 25 * 1024 * 1024 },
  'text/plain':               { kind: 'document', format: 'txt',  maxBytes: DOCUMENT_MAX_BYTES },
  'text/markdown':            { kind: 'document', format: 'md',   maxBytes: DOCUMENT_MAX_BYTES },
  'text/x-markdown':          { kind: 'document', format: 'md',   maxBytes: DOCUMENT_MAX_BYTES },
  'text/csv':                 { kind: 'document', format: 'csv',  maxBytes: DOCUMENT_MAX_BYTES },
  'application/octet-stream': { kind: 'document', format: 'txt',  maxBytes: DOCUMENT_MAX_BYTES },
}

// Bedrock's Converse API document block only accepts a handful of `format` values
// (pdf/csv/doc/docx/html/md/txt/xls/xlsx) -- anything else just goes in as 'txt'.
// Extension is the reliable signal for text/code files: browsers report wildly
// inconsistent (or empty) contentType for them depending on OS file associations
// (e.g. .csv as application/vnd.ms-excel on Windows, .json/.yaml/.py often with no
// contentType at all) -- so these are classified by extension instead of trusting it.
const TEXT_EXTENSIONS: Record<string, 'csv' | 'md' | 'txt'> = {
  csv: 'csv', tsv: 'csv',
  md: 'md', markdown: 'md',
  txt: 'txt', log: 'txt', json: 'txt', jsonl: 'txt', ndjson: 'txt',
  yaml: 'txt', yml: 'txt', xml: 'txt', html: 'txt', htm: 'txt',
  css: 'txt', scss: 'txt', less: 'txt',
  ini: 'txt', cfg: 'txt', conf: 'txt', toml: 'txt', env: 'txt', properties: 'txt',
  sh: 'txt', bash: 'txt', zsh: 'txt', bat: 'txt', ps1: 'txt',
  sql: 'txt', py: 'txt', rb: 'txt', php: 'txt', go: 'txt', rs: 'txt',
  js: 'txt', jsx: 'txt', mjs: 'txt', cjs: 'txt', ts: 'txt', tsx: 'txt',
  java: 'txt', kt: 'txt', kts: 'txt', c: 'txt', h: 'txt', cpp: 'txt', cc: 'txt',
  hpp: 'txt', cs: 'txt', swift: 'txt', lua: 'txt', pl: 'txt', r: 'txt',
  scala: 'txt', dart: 'txt', vue: 'txt', svelte: 'txt',
  graphql: 'txt', gql: 'txt', proto: 'txt', diff: 'txt', patch: 'txt',
  gitignore: 'txt', dockerfile: 'txt', makefile: 'txt', rst: 'txt', tex: 'txt',
}

function extOf(filename: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename)
  return m ? m[1].toLowerCase() : ''
}

function resolveAttachmentType(contentType: string, filename: string): AllowedType | null {
  const textFormat = TEXT_EXTENSIONS[extOf(filename)]
  if (textFormat) return { kind: 'document', format: textFormat, maxBytes: DOCUMENT_MAX_BYTES }
  if (ALLOWED[contentType]) return ALLOWED[contentType]
  if (contentType.startsWith('text/') || contentType === 'application/octet-stream') {
    return { kind: 'document', format: 'txt', maxBytes: DOCUMENT_MAX_BYTES }
  }
  return null
}

export function validateAttachment(contentType: string, sizeBytes: number, filename: string): AllowedType {
  const spec = resolveAttachmentType(contentType, filename)
  if (!spec) throw new Error(`Content type ${contentType} not allowed`)
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) throw new Error('File is empty or invalid size')
  if (sizeBytes > spec.maxBytes) {
    throw new Error(`File too large: ${sizeBytes} > ${spec.maxBytes} bytes`)
  }
  return spec
}

// ── Sanitize document name ────────────────────────────────────────────────────

export function sanitizeDocName(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '')
  return base
    .replace(/[^a-zA-Z0-9 \-()]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 200) || 'attachment'
}

// ── S3 key helpers ────────────────────────────────────────────────────────────

const BUCKET = process.env.ATTACHMENTS_BUCKET ?? ''

export function s3KeyPrefix(sub: string, chatId: string): string {
  return `attachments/${sub}/${chatId}/`
}

export function projectFilePrefix(sub: string, projectId: string): string {
  return `attachments/${sub}/project/${projectId}/`
}

export async function deleteProjectObjects(sub: string, projectId: string): Promise<void> {
  const prefix = projectFilePrefix(sub, projectId)
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }))
  const objects = list.Contents?.map(o => ({ Key: o.Key! }))
  if (!objects?.length) return
  await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects, Quiet: true } }))
}

export async function deleteS3Objects(keys: string[]): Promise<void> {
  if (keys.length === 0) return
  await s3.send(new DeleteObjectsCommand({
    Bucket: BUCKET,
    Delete: { Objects: keys.map(k => ({ Key: k })), Quiet: true },
  }))
}

// ── Presigned PUT (for browser upload) ───────────────────────────────────────

const s3 = new S3Client({})

export async function presignPut(key: string, contentType: string): Promise<string> {
  return s3GetSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: 900 },
  )
}

// ── Direct S3 write (server-side, e.g. tool-generated artifacts like browser screenshots) ────

export async function putObjectBytes(key: string, bytes: Uint8Array, contentType: string): Promise<string> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: bytes, ContentType: contentType }))
  return `s3://${BUCKET}/${key}`
}

// ── CloudFront signed URL (for display) ──────────────────────────────────────

const CF_DOMAIN    = process.env.CLOUDFRONT_DOMAIN    ?? ''
const CF_KEY_ID    = process.env.CLOUDFRONT_KEY_PAIR_ID ?? ''
const CF_KEY_PARAM = process.env.CLOUDFRONT_PRIVATE_KEY_SSM ?? ''

let _cfPrivateKey: string | null = null

async function getCfPrivateKey(): Promise<string> {
  if (_cfPrivateKey) return _cfPrivateKey
  const ssm = new SSMClient({})
  const res = await ssm.send(new GetParameterCommand({ Name: CF_KEY_PARAM, WithDecryption: true }))
  const value = res.Parameter?.Value
  if (!value) throw new Error('CloudFront private key not found in SSM')
  _cfPrivateKey = value
  return _cfPrivateKey
}

export async function signCloudFrontUrl(s3Key: string, privateKeyPem?: string): Promise<string> {
  // Decode percent-encoding before checking to block %2e%2e / %2F traversal attempts
  const decoded = decodeURIComponent(s3Key)
  if (!s3Key || decoded.includes('..') || decoded.startsWith('/') || s3Key.startsWith('/')) {
    throw new Error('invalid s3Key: path traversal not allowed')
  }
  const pem = privateKeyPem ?? await getCfPrivateKey()
  const url = `${CF_DOMAIN.replace(/\/$/, '')}/${s3Key}`
  const dateLessThan = new Date(Date.now() + 3600 * 1000)
  return cfGetSignedUrl({ url, keyPairId: CF_KEY_ID, dateLessThan, privateKey: pem })
}

// ── attachmentBlock: neutral Block for a user-uploaded attachment ─────────────

export interface AttachmentMeta {
  s3Key: string
  contentType: string
  filename: string
  mode?: 'standard' | 'rich'
}

export function attachmentBlock(meta: AttachmentMeta): Block {
  const spec = resolveAttachmentType(meta.contentType, meta.filename) ?? { kind: 'document', format: 'txt', maxBytes: DOCUMENT_MAX_BYTES }
  const uri = `s3://${BUCKET}/${meta.s3Key}`

  if (spec.kind === 'image') {
    return {
      kind: 'image',
      image: {
        format: meta.contentType.split('/')[1] as ImageFormat,
        source: { s3Uri: uri },
      },
    }
  }

  return {
    kind: 'document',
    document: {
      format: spec.format as DocumentFormat,
      name: sanitizeDocName(meta.filename),
      source: { s3Uri: uri },
      citations: meta.mode === 'rich',
    },
  }
}

// ── hydrateBlocks: replace s3Uri with bytes for the provider call ─────────────

// Rehydrate a single image/document entry's MediaSource from s3Uri → bytes.
// Used by both the top-level block path and the nested tool_result.entries[] path.
async function hydrateSource(source: { s3Uri: string } | { bytes: Uint8Array }, client: S3Client): Promise<{ bytes: Uint8Array }> {
  if ('bytes' in source) return source
  return { bytes: await fetchBytes(source.s3Uri, client) }
}

export async function hydrateBlocks(
  blocks: Block[],
  client: S3Client = s3,
): Promise<Block[]> {
  return Promise.all(
    blocks.map(async block => {
      // Top-level image / document blocks (user attachments)
      if (block.kind === 'image') {
        return { ...block, image: { ...block.image, source: await hydrateSource(block.image.source, client) } }
      }
      if (block.kind === 'document') {
        return { ...block, document: { ...block.document, source: await hydrateSource(block.document.source, client) } }
      }
      // Tool-result blocks: image entries can be nested inside entries[]
      // (browser screenshots are persisted as s3Uri inside tool_result.entries[]).
      // Without this branch the raw s3Uri reaches the provider on follow-up sends.
      if (block.kind === 'tool_result') {
        const hydratedEntries = await Promise.all(
          block.entries.map(async entry =>
            entry.kind === 'image'
              ? { ...entry, image: { ...entry.image, source: await hydrateSource(entry.image.source, client) } }
              : entry
          )
        )
        return { ...block, entries: hydratedEntries }
      }
      return block
    }),
  )
}

async function fetchBytes(s3Uri: string, client: S3Client): Promise<Uint8Array> {
  const without = s3Uri.replace('s3://', '')
  const slash = without.indexOf('/')
  const bucket = without.slice(0, slash)
  const key = without.slice(slash + 1)
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  return (res.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray()
}

// ── S3 chat object management ─────────────────────────────────────────────────

export async function deleteChatObjects(sub: string, chatId: string): Promise<void> {
  const prefix = s3KeyPrefix(sub, chatId)
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }))
  const objects = list.Contents?.map(o => ({ Key: o.Key! }))
  if (!objects?.length) return
  await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects, Quiet: true } }))
}

export async function copyChatObjects(
  sub: string,
  srcChatId: string,
  dstChatId: string,
): Promise<Map<string, string>> {
  const prefix = s3KeyPrefix(sub, srcChatId)
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }))
  const keyMap = new Map<string, string>()
  for (const obj of list.Contents ?? []) {
    const oldKey = obj.Key!
    const newKey = oldKey.replace(prefix, s3KeyPrefix(sub, dstChatId))
    await s3.send(new CopyObjectCommand({
      Bucket: BUCKET,
      CopySource: `${BUCKET}/${oldKey}`,
      Key: newKey,
    }))
    keyMap.set(oldKey, newKey)
  }
  return keyMap
}

// Remap a single s3Uri MediaSource via keyMap; bytes sources pass through unchanged.
function rewriteSource(source: { s3Uri: string } | { bytes: Uint8Array }, keyMap: Map<string, string>): { s3Uri: string } | { bytes: Uint8Array } {
  if (!('s3Uri' in source)) return source
  const oldKey = source.s3Uri.replace(`s3://${BUCKET}/`, '')
  const newKey = keyMap.get(oldKey)
  return newKey ? { s3Uri: `s3://${BUCKET}/${newKey}` } : source
}

export function rewriteBlockUri(block: Block, keyMap: Map<string, string>): Block {
  if (block.kind === 'image') {
    return { ...block, image: { ...block.image, source: rewriteSource(block.image.source, keyMap) } }
  }
  if (block.kind === 'document') {
    return { ...block, document: { ...block.document, source: rewriteSource(block.document.source, keyMap) } }
  }
  // Nested tool-result images (browser screenshots) — remap to the forked chat's S3 keys
  if (block.kind === 'tool_result') {
    const remapped = block.entries.map(entry =>
      entry.kind === 'image' ? { ...entry, image: { ...entry.image, source: rewriteSource(entry.image.source, keyMap) } } : entry
    )
    return { ...block, entries: remapped }
  }
  return block
}
