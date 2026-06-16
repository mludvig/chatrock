// Mock S3Client and commands before imports (jest.mock is hoisted)
const mockS3Send = jest.fn()
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn(),
  PutObjectCommand: jest.fn(),
}))

jest.mock('../../src/lib/bedrock')

import { summarizeFile } from '../../src/lib/projectFiles'
import * as bedrock from '../../src/lib/bedrock'

const mockBedrock = bedrock as jest.Mocked<typeof bedrock>

function makeS3Body(text: string) {
  return { transformToByteArray: () => Promise.resolve(new TextEncoder().encode(text)) }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockS3Send.mockResolvedValue({ Body: makeS3Body('file content') })
  mockBedrock.converseOnce.mockResolvedValue(JSON.stringify({
    microLabel: 'Test file label',
    summary: 'This is a test file summary.',
  }))
})

test('text file — calls Bedrock, returns microLabel + summary + extractedTextKey', async () => {
  const result = await summarizeFile({ s3Key: 'proj/file.txt', contentType: 'text/plain', filename: 'notes.txt' })
  expect(mockBedrock.converseOnce).toHaveBeenCalled()
  expect(result.microLabel).toBe('Test file label')
  expect(result.summary).toBe('This is a test file summary.')
  expect(result.extractedTextKey).toBeDefined()
})

test('image file — calls Bedrock with image block, no extractedTextKey', async () => {
  const result = await summarizeFile({ s3Key: 'proj/img.png', contentType: 'image/png', filename: 'diagram.png' })
  expect(mockBedrock.converseOnce).toHaveBeenCalled()
  // Verify image block passed (check the message content)
  const callArgs = mockBedrock.converseOnce.mock.calls[0]
  const msgs = callArgs[2] as Array<{ role: string; content: unknown[] }>
  expect(msgs[0].content[0]).toHaveProperty('image')
  expect(result.extractedTextKey).toBeUndefined()
})

test('PDF file — calls Bedrock with document block', async () => {
  const result = await summarizeFile({ s3Key: 'proj/doc.pdf', contentType: 'application/pdf', filename: 'report.pdf' })
  expect(mockBedrock.converseOnce).toHaveBeenCalled()
  const callArgs = mockBedrock.converseOnce.mock.calls[0]
  const msgs = callArgs[2] as Array<{ role: string; content: unknown[] }>
  expect(msgs[0].content[0]).toHaveProperty('document')
  expect(result.microLabel).toBe('Test file label')
})

test('binary/unknown type — returns stub without calling Bedrock', async () => {
  const result = await summarizeFile({ s3Key: 'proj/bin.exe', contentType: 'application/x-binary', filename: 'app.exe' })
  expect(mockBedrock.converseOnce).not.toHaveBeenCalled()
  expect(result.microLabel).toContain('app.exe')
  expect(result.summary).toContain('binary')
})

test('Bedrock throws — returns fallback, never throws', async () => {
  mockBedrock.converseOnce.mockRejectedValue(new Error('model error'))
  const result = await summarizeFile({ s3Key: 'proj/fail.txt', contentType: 'text/plain', filename: 'fail.txt' })
  expect(result.microLabel).toBeDefined()
  expect(result.summary).toBeDefined()
})

test('malformed JSON from Bedrock — returns raw text as summary', async () => {
  mockBedrock.converseOnce.mockResolvedValue('not json')
  const result = await summarizeFile({ s3Key: 'proj/bad.txt', contentType: 'text/plain', filename: 'bad.txt' })
  expect(result.microLabel).toBe('File')
  expect(result.summary).toContain('not json')
})
