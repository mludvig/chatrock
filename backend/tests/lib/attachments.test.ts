// Mock the AWS SDK clients — no real AWS calls
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  DeleteObjectsCommand: jest.fn(),
  CopyObjectCommand: jest.fn(),
  ListObjectsV2Command: jest.fn(),
}))
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3-presigned.example.com/upload?sig=x'),
}))
jest.mock('@aws-sdk/cloudfront-signer', () => ({
  getSignedUrl: jest.fn().mockReturnValue('https://cdn.example.com/attachments/key?Signature=x'),
}))
// Mock SSM so we don't call AWS
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  GetParameterCommand: jest.fn(),
}))

// Set required env vars before loading the module
process.env.ATTACHMENTS_BUCKET = 'chatrock-attachments-123456789012-ap-southeast-2-an'
process.env.CLOUDFRONT_DOMAIN   = 'https://chatrock.ccxdemo.dev'
process.env.CLOUDFRONT_KEY_PAIR_ID      = 'KPID123'
process.env.CLOUDFRONT_PRIVATE_KEY_SSM  = '/chatrock/cloudfront/attachments_private_key'

import {
  validateAttachment,
  presignPut,
  signCloudFrontUrl,
  attachmentBlock,
  hydrateBlocks,
  rewriteBlockUri,
  s3KeyPrefix,
} from '../../src/lib/attachments'
import { getSignedUrl as s3SignedUrl } from '@aws-sdk/s3-request-presigner'
import { getSignedUrl as cfSignedUrl } from '@aws-sdk/cloudfront-signer'
import { S3Client } from '@aws-sdk/client-s3'

// ── validateAttachment ────────────────────────────────────────────────────────

test('validateAttachment accepts image/png within size limit', () => {
  expect(() => validateAttachment('image/png', 1024 * 1024, 'photo.png')).not.toThrow()
})

test('validateAttachment rejects image/bmp (not in allowlist)', () => {
  expect(() => validateAttachment('image/bmp', 100, 'photo.bmp')).toThrow(/not allowed/)
})

test('validateAttachment rejects image/png over 5 MB', () => {
  expect(() => validateAttachment('image/png', 6 * 1024 * 1024, 'photo.png')).toThrow(/too large/)
})

test('validateAttachment rejects pdf over 25 MB', () => {
  expect(() => validateAttachment('application/pdf', 26 * 1024 * 1024, 'report.pdf')).toThrow(/too large/)
})

test('validateAttachment accepts text/plain within 1 MB', () => {
  expect(() => validateAttachment('text/plain', 500 * 1024, 'notes.txt')).not.toThrow()
})

// ── validateAttachment: extension-based text classification ───────────────────

test('validateAttachment accepts .csv reported with a vendor MIME type (Windows Excel association)', () => {
  expect(() => validateAttachment('application/vnd.ms-excel', 1024, 'data.csv')).not.toThrow()
})

test('validateAttachment accepts .json with no browser-supplied contentType', () => {
  expect(() => validateAttachment('application/octet-stream', 1024, 'config.json')).not.toThrow()
})

test('validateAttachment accepts .py reported as application/json (extension wins over contentType)', () => {
  expect(() => validateAttachment('application/json', 1024, 'script.py')).not.toThrow()
})

test('validateAttachment accepts an arbitrary text/* subtype not in the explicit allowlist', () => {
  expect(() => validateAttachment('text/x-python', 1024, 'script')).not.toThrow()
})

test('validateAttachment rejects an unrecognized extension with an unrecognized contentType', () => {
  expect(() => validateAttachment('application/x-msdownload', 1024, 'app.exe')).toThrow(/not allowed/)
})

test('validateAttachment caps extension-classified text files at 1 MB', () => {
  expect(() => validateAttachment('application/octet-stream', 2 * 1024 * 1024, 'big.log')).toThrow(/too large/)
})

// ── sanitizeDocName ───────────────────────────────────────────────────────────

test('attachmentBlock uses sanitized name for document blocks', () => {
  const block = attachmentBlock({
    s3Key: 'attachments/sub/chat/file-id/Report__2026.pdf',
    contentType: 'application/pdf',
    filename: 'Report  2026.pdf',
    mode: 'standard',
  })
  expect(block.kind).toBe('document')
  const doc = (block as { kind: 'document'; document: { name: string } }).document
  // consecutive spaces collapsed, trailing extension stripped
  expect(doc.name).toMatch(/^[a-zA-Z0-9 \-()]+$/)
  expect(doc.name).not.toMatch(/ {2}/)
})

// ── attachmentBlock ───────────────────────────────────────────────────────────

test('attachmentBlock builds image block with s3Uri', () => {
  const block = attachmentBlock({
    s3Key: 'attachments/sub/chat/fid/screenshot.png',
    contentType: 'image/png',
    filename: 'screenshot.png',
  })
  expect(block).toMatchObject({
    kind: 'image',
    image: {
      format: 'png',
      source: {
        s3Uri: `s3://${process.env.ATTACHMENTS_BUCKET}/attachments/sub/chat/fid/screenshot.png`,
      },
    },
  })
})

test('attachmentBlock builds document block with citations disabled for standard mode', () => {
  const block = attachmentBlock({
    s3Key: 'attachments/sub/chat/fid/report.pdf',
    contentType: 'application/pdf',
    filename: 'report.pdf',
    mode: 'standard',
  })
  const doc = (block as { kind: 'document'; document: { citations?: boolean } }).document
  expect(doc.citations).toBe(false)
})

test('attachmentBlock resolves document format from extension when contentType is a vendor MIME', () => {
  const block = attachmentBlock({
    s3Key: 'attachments/sub/chat/fid/data.csv',
    contentType: 'application/vnd.ms-excel',
    filename: 'data.csv',
  })
  const doc = (block as { kind: 'document'; document: { format: string } }).document
  expect(doc.format).toBe('csv')
})

test('attachmentBlock falls back to txt format for unrecognized code extensions', () => {
  const block = attachmentBlock({
    s3Key: 'attachments/sub/chat/fid/script.py',
    contentType: 'application/octet-stream',
    filename: 'script.py',
  })
  const doc = (block as { kind: 'document'; document: { format: string } }).document
  expect(doc.format).toBe('txt')
})

test('attachmentBlock enables citations for rich mode', () => {
  const block = attachmentBlock({
    s3Key: 'attachments/sub/chat/fid/report.pdf',
    contentType: 'application/pdf',
    filename: 'report.pdf',
    mode: 'rich',
  })
  const doc = (block as { kind: 'document'; document: { citations?: boolean } }).document
  expect(doc.citations).toBe(true)
})

// ── presignPut ────────────────────────────────────────────────────────────────

test('presignPut returns a presigned upload URL', async () => {
  const url = await presignPut('attachments/sub/chat/fid/file.png', 'image/png')
  expect(s3SignedUrl).toHaveBeenCalled()
  expect(url).toBe('https://s3-presigned.example.com/upload?sig=x')
})

// ── signCloudFrontUrl ─────────────────────────────────────────────────────────

test('signCloudFrontUrl produces a CloudFront signed URL', async () => {
  ;(cfSignedUrl as jest.Mock).mockReturnValue('https://chatrock.ccxdemo.dev/attachments/sub/chat/fid/file.png?Signature=x')

  const url = await signCloudFrontUrl('attachments/sub/chat/fid/file.png', 'fakepem')
  expect(url).toContain('chatrock.ccxdemo.dev')
  expect(url).toContain('Signature=')
})

test('signCloudFrontUrl rejects keys with path traversal', async () => {
  await expect(signCloudFrontUrl('../etc/passwd', 'fakepem')).rejects.toThrow(/invalid/)
})

// ── hydrateBlocks ─────────────────────────────────────────────────────────────

test('hydrateBlocks replaces s3Uri with bytes for image blocks', async () => {
  const fakeBytes = Buffer.from('PNG data')
  const s3Client = new S3Client({}) as jest.Mocked<S3Client>
  s3Client.send = jest.fn().mockResolvedValue({
    Body: { transformToByteArray: async () => fakeBytes },
  })

  const bucket = process.env.ATTACHMENTS_BUCKET!
  const blocks = [
    { kind: 'image' as const, image: { format: 'png' as const, source: { s3Uri: `s3://${bucket}/key.png` } } },
  ]
  const result = await hydrateBlocks(blocks, s3Client)
  expect(result[0]).toMatchObject({ kind: 'image', image: { format: 'png', source: { bytes: fakeBytes } } })
})

test('hydrateBlocks passes through text blocks unchanged', async () => {
  const s3Client = new S3Client({}) as jest.Mocked<S3Client>
  s3Client.send = jest.fn()

  const blocks = [{ kind: 'text' as const, text: 'hello' }]
  const result = await hydrateBlocks(blocks, s3Client)
  expect(result).toEqual([{ kind: 'text', text: 'hello' }])
  expect(s3Client.send).not.toHaveBeenCalled()
})

test('hydrateBlocks rehydrates nested image inside tool_result.entries[]', async () => {
  // Regression test: browser screenshots are persisted as s3Uri inside tool_result.entries[].
  // Without this fix, the raw s3Uri reaches the provider on follow-up sends and causes
  // "ValidationException: This model doesn't support the s3Uri field."
  const fakeBytes = Buffer.from('PNG screenshot')
  const s3Client = new S3Client({}) as jest.Mocked<S3Client>
  s3Client.send = jest.fn().mockResolvedValue({
    Body: { transformToByteArray: async () => fakeBytes },
  })

  const blocks = [
    {
      kind: 'tool_result' as const,
      callId: 'tu-1',
      isError: false,
      entries: [
        { kind: 'text' as const, text: 'Screenshot taken' },
        { kind: 'image' as const, image: { format: 'png' as const, source: { s3Uri: `s3://${process.env.ATTACHMENTS_BUCKET}/browser-tu-1-0.png` } } },
      ],
    },
  ]
  const result = await hydrateBlocks(blocks, s3Client)
  const tr = (result[0] as { kind: 'tool_result'; callId: string; isError: boolean; entries: unknown[] })
  expect(tr.callId).toBe('tu-1')
  expect(tr.isError).toBe(false)
  expect(tr.entries[0]).toEqual({ kind: 'text', text: 'Screenshot taken' })
  expect(tr.entries[1]).toMatchObject({ kind: 'image', image: { format: 'png', source: { bytes: fakeBytes } } })
  expect(s3Client.send).toHaveBeenCalledTimes(1)
})

test('hydrateBlocks leaves text-only tool_result unchanged without S3 calls', async () => {
  const s3Client = new S3Client({}) as jest.Mocked<S3Client>
  s3Client.send = jest.fn()

  const blocks = [
    {
      kind: 'tool_result' as const,
      callId: 'tu-2',
      isError: false,
      entries: [{ kind: 'text' as const, text: 'web_search result' }],
    },
  ]
  const result = await hydrateBlocks(blocks, s3Client)
  expect(result).toEqual(blocks)
  expect(s3Client.send).not.toHaveBeenCalled()
})

test('rewriteBlockUri remaps nested tool_result image s3Uri via keyMap', () => {
  const bucket = process.env.ATTACHMENTS_BUCKET!
  const keyMap = new Map([
    ['attachments/sub/chat-src/browser-tu-1-0.png', 'attachments/sub/chat-dst/browser-tu-1-0.png'],
  ])
  const block = {
    kind: 'tool_result' as const,
    callId: 'tu-1',
    isError: false,
    entries: [
      { kind: 'text' as const, text: 'snap' },
      {
        kind: 'image' as const,
        image: {
          format: 'png' as const,
          source: { s3Uri: `s3://${bucket}/attachments/sub/chat-src/browser-tu-1-0.png` },
        },
      },
    ],
  }
  const result = rewriteBlockUri(block, keyMap) as {
    kind: 'tool_result'
    entries: Array<{ kind: string; image?: { source?: { s3Uri?: string } } }>
  }
  expect(result.entries[0]).toEqual({ kind: 'text', text: 'snap' })
  expect(result.entries[1].image?.source?.s3Uri).toBe(
    `s3://${bucket}/attachments/sub/chat-dst/browser-tu-1-0.png`
  )
})

// ── s3KeyPrefix ───────────────────────────────────────────────────────────────

test('s3KeyPrefix returns correct chat prefix', () => {
  expect(s3KeyPrefix('user-sub-1', 'chat-id-1')).toBe('attachments/user-sub-1/chat-id-1/')
})
