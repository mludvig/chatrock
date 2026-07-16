import type { Tool, ToolResultBlock } from '@aws-sdk/client-bedrock-runtime'
import { getImageProvider, DEFAULT_IMAGE_PROVIDER_ID } from './registry'

const provider = getImageProvider(DEFAULT_IMAGE_PROVIDER_ID)

export const GENERATE_IMAGE_TOOL: Tool = {
  toolSpec: {
    name: 'generate_image',
    description: `Generate an image from a text description. ${provider.promptGuidance} Use this when the user asks you to create, draw, generate, or make a picture, image, or illustration.`,
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'A detailed description of the image to generate.' },
          negativePrompt: { type: 'string', description: 'Elements to avoid in the generated image.' },
          aspectRatio: { type: 'string', enum: provider.aspectRatios, description: "Image aspect ratio. Default '1:1'." },
        },
        required: ['prompt'],
      },
    },
  },
}

export async function executeGenerateImageTool(input: Record<string, unknown>, ctx: { chatId?: string }): Promise<ToolResultBlock> {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt) return { toolUseId: '', content: [{ text: 'Missing required field: prompt' }], status: 'error' }

  try {
    const image = await provider.generate({
      prompt,
      negativePrompt: typeof input.negativePrompt === 'string' ? input.negativePrompt : undefined,
      aspectRatio: typeof input.aspectRatio === 'string' ? input.aspectRatio : undefined,
    })
    console.log(JSON.stringify({ event: 'generate_image', provider: provider.id, result: 'success', chatId: ctx.chatId }))
    return {
      toolUseId: '',
      // The prompt text travels alongside the image (not just in the tool_call input, which
      // the frontend truncates to a short pill label) — bedrock.ts's existing text+image
      // tool-result handling threads it through as step.result, so the full prompt renders
      // via the generic result-text fallback with no new frontend code needed.
      content: [
        { text: prompt },
        { image: { format: image.format, source: { bytes: image.bytes } } },
      ] as ToolResultBlock['content'],
      status: 'success',
    }
  } catch (err) {
    console.log(JSON.stringify({ event: 'generate_image', provider: provider.id, result: 'error', chatId: ctx.chatId }))
    return { toolUseId: '', content: [{ text: `Image generation failed: ${String(err)}` }], status: 'error' }
  }
}
