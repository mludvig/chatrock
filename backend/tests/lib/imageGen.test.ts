jest.mock('@aws-sdk/client-bedrock-runtime', () => {
  const actual = jest.requireActual('@aws-sdk/client-bedrock-runtime')
  return {
    ...actual,
    BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
      send: jest.fn(),
    })),
  }
})

import { stabilityClient, bedrockStabilityProvider } from '../../src/lib/imageGen/providers/bedrockStability'
import { getImageProvider, DEFAULT_IMAGE_PROVIDER_ID } from '../../src/lib/imageGen/registry'
import { executeGenerateImageTool, GENERATE_IMAGE_TOOL } from '../../src/lib/imageGen/tool'

function getMockSend() {
  return (stabilityClient as unknown as { send: jest.Mock }).send
}

function fakeInvokeResponse(body: Record<string, unknown>) {
  return { body: new TextEncoder().encode(JSON.stringify(body)) }
}

beforeEach(() => {
  getMockSend().mockReset()
})

// ── registry ───────────────────────────────────────────────────────────────────

test('getImageProvider falls back to the default provider for an unknown id', () => {
  expect(getImageProvider('nonexistent')).toBe(bedrockStabilityProvider)
  expect(getImageProvider()).toBe(bedrockStabilityProvider)
  expect(DEFAULT_IMAGE_PROVIDER_ID).toBe(bedrockStabilityProvider.id)
})

// ── bedrockStabilityProvider.generate ────────────────────────────────────────────

describe('bedrockStabilityProvider.generate', () => {
  test('sends prompt/negative_prompt/aspect_ratio and decodes the base64 image', async () => {
    const imageB64 = Buffer.from('fake-png-bytes').toString('base64')
    getMockSend().mockResolvedValueOnce(fakeInvokeResponse({ images: [imageB64], finish_reasons: [null] }))

    const result = await bedrockStabilityProvider.generate({
      prompt: 'a red panda skateboarding',
      negativePrompt: 'blurry, low quality',
      aspectRatio: '16:9',
    })

    expect(result.format).toBe('png')
    expect(Buffer.from(result.bytes).toString()).toBe('fake-png-bytes')

    const sentCommand = getMockSend().mock.calls[0][0] as { input: { modelId: string; body: string } }
    const sentBody = JSON.parse(sentCommand.input.body)
    expect(sentCommand.input.modelId).toBe('stability.stable-image-ultra-v1:1')
    expect(sentBody).toMatchObject({
      prompt: 'a red panda skateboarding',
      negative_prompt: 'blurry, low quality',
      aspect_ratio: '16:9',
      output_format: 'png',
    })
  })

  test('omits negative_prompt/aspect_ratio when not provided', async () => {
    const imageB64 = Buffer.from('x').toString('base64')
    getMockSend().mockResolvedValueOnce(fakeInvokeResponse({ images: [imageB64], finish_reasons: [null] }))

    await bedrockStabilityProvider.generate({ prompt: 'a cat' })

    const sentCommand = getMockSend().mock.calls[0][0] as { input: { body: string } }
    const sentBody = JSON.parse(sentCommand.input.body)
    expect(sentBody).not.toHaveProperty('negative_prompt')
    expect(sentBody).not.toHaveProperty('aspect_ratio')
  })

  test('ignores an aspect ratio not in the supported enum', async () => {
    const imageB64 = Buffer.from('x').toString('base64')
    getMockSend().mockResolvedValueOnce(fakeInvokeResponse({ images: [imageB64], finish_reasons: [null] }))

    await bedrockStabilityProvider.generate({ prompt: 'a cat', aspectRatio: '7:3' })

    const sentCommand = getMockSend().mock.calls[0][0] as { input: { body: string } }
    expect(JSON.parse(sentCommand.input.body)).not.toHaveProperty('aspect_ratio')
  })

  test('throws when the response carries a non-null finish_reason (content filtered)', async () => {
    getMockSend().mockResolvedValueOnce(fakeInvokeResponse({ finish_reasons: ['Filter reason: prompt'] }))

    await expect(bedrockStabilityProvider.generate({ prompt: 'blocked prompt' }))
      .rejects.toThrow(/Filter reason: prompt/)
  })

  test('throws when the response has no image', async () => {
    getMockSend().mockResolvedValueOnce(fakeInvokeResponse({ images: [], finish_reasons: [null] }))

    await expect(bedrockStabilityProvider.generate({ prompt: 'a cat' }))
      .rejects.toThrow(/no image/)
  })
})

// ── executeGenerateImageTool ──────────────────────────────────────────────────

describe('executeGenerateImageTool', () => {
  test('returns an error result when prompt is missing', async () => {
    const result = await executeGenerateImageTool({}, {})
    expect(result.isError).toBe(true)
    expect((result.entries[0] as { text: string }).text).toMatch(/Missing required field: prompt/)
  })

  test('returns an error result when prompt is blank', async () => {
    const result = await executeGenerateImageTool({ prompt: '   ' }, {})
    expect(result.isError).toBe(true)
  })

  test('returns a success result with an image entry', async () => {
    const imageB64 = Buffer.from('fake-bytes').toString('base64')
    getMockSend().mockResolvedValueOnce(fakeInvokeResponse({ images: [imageB64], finish_reasons: [null] }))

    const result = await executeGenerateImageTool({ prompt: 'a red panda skateboarding' }, { chatId: 'chat-1' })

    expect(result.isError).toBe(false)
    expect(result.entries).toEqual([
      { kind: 'text', text: 'a red panda skateboarding' },
      { kind: 'image', format: 'png', bytes: expect.any(Uint8Array) },
    ])
  })

  test('returns an error result when the provider throws', async () => {
    getMockSend().mockRejectedValueOnce(new Error('Bedrock unavailable'))

    const result = await executeGenerateImageTool({ prompt: 'a cat' }, {})

    expect(result.isError).toBe(true)
    expect((result.entries[0] as { text: string }).text).toMatch(/Image generation failed/)
  })
})

// ── GENERATE_IMAGE_TOOL spec ──────────────────────────────────────────────────

test('GENERATE_IMAGE_TOOL spec requires prompt and exposes the provider aspect ratios', () => {
  expect(GENERATE_IMAGE_TOOL.name).toBe('generate_image')
  const schema = GENERATE_IMAGE_TOOL.inputSchema as { required: string[]; properties: { aspectRatio: { enum: string[] } } }
  expect(schema.required).toEqual(['prompt'])
  expect(schema.properties.aspectRatio.enum).toEqual(bedrockStabilityProvider.aspectRatios)
})
