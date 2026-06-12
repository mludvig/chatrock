import { S3Client, GetObjectCommand, DeleteObjectsCommand, CopyObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { getSignedUrl as s3GetSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getSignedUrl as cfGetSignedUrl } from '@aws-sdk/cloudfront-signer'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime'

// ── Allowlist ─────────────────────────────────────────────────────────────────

interface AllowedType {
  kind: 'image' | 'document'
  format: string
  maxBytes: number
}

const ALLOWED: Record<string, AllowedType> = {
  'image/png':                { kind: 'image',    format: 'png',  maxBytes: 5 * 1024 * 1024 },
  'image/jpeg':               { kind: 'image',    format: 'jpeg', maxBytes: 5 * 1024 * 1024 },
  'image/gif':                { kind: 'image',    format: 'gif',  maxBytes: 5 * 1024 * 1024 },
  'image/webp':               { kind: 'image',    format: 'webp', maxBytes: 5 * 1024 * 1024 },
  'application/pdf':          { kind: 'document', format: 'pdf',  maxBytes: 25 * 1024 * 1024 },
  'text/plain':               { kind: 'document', format: 'txt',  maxBytes: 1 * 1024 * 1024 },
  'text/markdown':            { kind: 'document', format: 'md',   maxBytes: 1 * 1024 * 1024 },
  'text/x-markdown':          { kind: 'document', format: 'md',   maxBytes: 1 * 1024 * 1024 },
  'text/csv':                 { kind: 'document', format: 'csv',  maxBytes: 1 * 1024 * 1024 },
  'application/octet-stream': { kind: 'document', format: 'txt',  maxBytes: 1 * 1024 * 1024 },
}

export function validateAttachment(contentType: string, sizeBytes: number): AllowedType {
  const spec = ALLOWED[contentType]
  if (!spec) throw new Error(`Content type ${contentType} not allowed`)
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

// ── Presigned PUT (for browser upload) ───────────────────────────────────────

const s3 = new S3Client({})

export async function presignPut(key: string, contentType: string): Promise<string> {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3')
  return s3GetSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: 900 },
  )
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
  _cfPrivateKey = res.Parameter?.Value ?? ''
  return _cfPrivateKey
}

export async function signCloudFrontUrl(s3Key: string, privateKeyPem?: string): Promise<string> {
  if (!s3Key || s3Key.includes('..') || s3Key.startsWith('/')) {
    throw new Error('invalid s3Key: path traversal not allowed')
  }
  const pem = privateKeyPem ?? await getCfPrivateKey()
  const url = `${CF_DOMAIN.replace(/\/$/, '')}/${s3Key}`
  const dateLessThan = new Date(Date.now() + 3600 * 1000)
  return cfGetSignedUrl({ url, keyPairId: CF_KEY_ID, dateLessThan, privateKey: pem })
}

// ── attachmentBlock: ContentBlock for Bedrock ─────────────────────────────────

export interface AttachmentMeta {
  s3Key: string
  contentType: string
  filename: string
  mode?: 'standard' | 'rich'
}

export function attachmentBlock(meta: AttachmentMeta): ContentBlock {
  const spec = ALLOWED[meta.contentType] ?? { kind: 'document', format: 'txt' }
  const uri = `s3://${BUCKET}/${meta.s3Key}`

  if (spec.kind === 'image') {
    return {
      image: {
        format: meta.contentType.split('/')[1] as 'png' | 'jpeg' | 'gif' | 'webp',
        source: { s3Location: { uri } },
      },
    } as ContentBlock
  }

  return {
    document: {
      format: spec.format as 'pdf' | 'txt' | 'md' | 'csv',
      name: sanitizeDocName(meta.filename),
      source: { s3Location: { uri } },
      citations: { enabled: meta.mode === 'rich' },
    },
  } as ContentBlock
}

// ── hydrateBlocks: replace s3Location with bytes for Bedrock API call ─────────

export async function hydrateBlocks(
  blocks: ContentBlock[],
  client: S3Client = s3,
): Promise<ContentBlock[]> {
  return Promise.all(
    blocks.map(async block => {
      if ('image' in block && block.image) {
        const src = block.image.source as { s3Location?: { uri: string } }
        if (src?.s3Location) {
          const bytes = await fetchBytes(src.s3Location.uri, client)
          return { image: { ...block.image, source: { bytes } } } as ContentBlock
        }
      }
      if ('document' in block && block.document) {
        const src = block.document.source as { s3Location?: { uri: string } }
        if (src?.s3Location) {
          const bytes = await fetchBytes(src.s3Location.uri, client)
          return { document: { ...block.document, source: { bytes } } } as ContentBlock
        }
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

export function rewriteBlockUri(block: ContentBlock, keyMap: Map<string, string>): ContentBlock {
  if ('image' in block && block.image) {
    const src = block.image.source as { s3Location?: { uri: string } }
    if (src?.s3Location) {
      const oldKey = src.s3Location.uri.replace(`s3://${BUCKET}/`, '')
      const newKey = keyMap.get(oldKey)
      if (newKey) {
        return { image: { ...block.image, source: { s3Location: { uri: `s3://${BUCKET}/${newKey}` } } } } as ContentBlock
      }
    }
  }
  if ('document' in block && block.document) {
    const src = block.document.source as { s3Location?: { uri: string } }
    if (src?.s3Location) {
      const oldKey = src.s3Location.uri.replace(`s3://${BUCKET}/`, '')
      const newKey = keyMap.get(oldKey)
      if (newKey) {
        return { document: { ...block.document, source: { s3Location: { uri: `s3://${BUCKET}/${newKey}` } } } } as ContentBlock
      }
    }
  }
  return block
}
