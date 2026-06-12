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
  s3KeyPrefix,
} from '../../src/lib/attachments'
import { getSignedUrl as s3SignedUrl } from '@aws-sdk/s3-request-presigner'
import { getSignedUrl as cfSignedUrl } from '@aws-sdk/cloudfront-signer'
import { S3Client } from '@aws-sdk/client-s3'

// ── validateAttachment ────────────────────────────────────────────────────────

test('validateAttachment accepts image/png within size limit', () => {
  expect(() => validateAttachment('image/png', 1024 * 1024)).not.toThrow()
})

test('validateAttachment rejects image/bmp (not in allowlist)', () => {
  expect(() => validateAttachment('image/bmp', 100)).toThrow(/not allowed/)
})

test('validateAttachment rejects image/png over 5 MB', () => {
  expect(() => validateAttachment('image/png', 6 * 1024 * 1024)).toThrow(/too large/)
})

test('validateAttachment rejects pdf over 25 MB', () => {
  expect(() => validateAttachment('application/pdf', 26 * 1024 * 1024)).toThrow(/too large/)
})

test('validateAttachment accepts text/plain within 1 MB', () => {
  expect(() => validateAttachment('text/plain', 500 * 1024)).not.toThrow()
})

// ── sanitizeDocName ───────────────────────────────────────────────────────────

test('attachmentBlock uses sanitized name for document blocks', () => {
  const block = attachmentBlock({
    s3Key: 'attachments/sub/chat/file-id/Report__2026.pdf',
    contentType: 'application/pdf',
    filename: 'Report  2026.pdf',
    mode: 'standard',
  })
  expect(block).toHaveProperty('document')
  const doc = (block as { document: { name: string; citations?: { enabled: boolean } } }).document
  // consecutive spaces collapsed, trailing extension stripped
  expect(doc.name).toMatch(/^[a-zA-Z0-9 \-()]+$/)
  expect(doc.name).not.toMatch(/ {2}/)
})

// ── attachmentBlock ───────────────────────────────────────────────────────────

test('attachmentBlock builds image block with s3Location', () => {
  const block = attachmentBlock({
    s3Key: 'attachments/sub/chat/fid/screenshot.png',
    contentType: 'image/png',
    filename: 'screenshot.png',
  })
  expect(block).toMatchObject({
    image: {
      format: 'png',
      source: {
        s3Location: {
          uri: `s3://chatrock-attachments-123456789012-ap-southeast-2-an/attachments/sub/chat/fid/screenshot.png`,
        },
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
  const doc = (block as { document: { citations: { enabled: boolean } } }).document
  expect(doc.citations.enabled).toBe(false)
})

test('attachmentBlock enables citations for rich mode', () => {
  const block = attachmentBlock({
    s3Key: 'attachments/sub/chat/fid/report.pdf',
    contentType: 'application/pdf',
    filename: 'report.pdf',
    mode: 'rich',
  })
  const doc = (block as { document: { citations: { enabled: boolean } } }).document
  expect(doc.citations.enabled).toBe(true)
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

test('hydrateBlocks replaces s3Location with bytes for image blocks', async () => {
  const fakeBytes = Buffer.from('PNG data')
  const s3Client = new S3Client({}) as jest.Mocked<S3Client>
  s3Client.send = jest.fn().mockResolvedValue({
    Body: { transformToByteArray: async () => fakeBytes },
  })

  const blocks = [
    { image: { format: 'png', source: { s3Location: { uri: 's3://bucket/key.png' } } } },
  ]
  const result = await hydrateBlocks(blocks as never, s3Client)
  expect(result[0]).toMatchObject({ image: { format: 'png', source: { bytes: fakeBytes } } })
})

test('hydrateBlocks passes through text blocks unchanged', async () => {
  const s3Client = new S3Client({}) as jest.Mocked<S3Client>
  s3Client.send = jest.fn()

  const blocks = [{ text: 'hello' }]
  const result = await hydrateBlocks(blocks as never, s3Client)
  expect(result).toEqual([{ text: 'hello' }])
  expect(s3Client.send).not.toHaveBeenCalled()
})

// ── s3KeyPrefix ───────────────────────────────────────────────────────────────

test('s3KeyPrefix returns correct chat prefix', () => {
  expect(s3KeyPrefix('user-sub-1', 'chat-id-1')).toBe('attachments/user-sub-1/chat-id-1/')
})
