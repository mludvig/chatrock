import type { ToolSpec, ToolResult } from '../llm/toolSpec'
import { getImageProvider, DEFAULT_IMAGE_PROVIDER_ID } from './registry'

const provider = getImageProvider(DEFAULT_IMAGE_PROVIDER_ID)

export const GENERATE_IMAGE_TOOL: ToolSpec = {
  name: 'generate_image',
  description: `Generate an image from a text description. ${provider.promptGuidance} Use this when the user asks you to create, draw, generate, or make a picture, image, or illustration.`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'A detailed description of the image to generate.' },
      negativePrompt: { type: 'string', description: 'Elements to avoid in the generated image.' },
      aspectRatio: { type: 'string', enum: provider.aspectRatios, description: "Image aspect ratio. Default '1:1'." },
    },
    required: ['prompt'],
  },
}

export async function executeGenerateImageTool(input: Record<string, unknown>, ctx: { chatId?: string }): Promise<ToolResult> {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt) return { entries: [{ kind: 'text', text: 'Missing required field: prompt' }], isError: true }

  try {
    const image = await provider.generate({
      prompt,
      negativePrompt: typeof input.negativePrompt === 'string' ? input.negativePrompt : undefined,
      aspectRatio: typeof input.aspectRatio === 'string' ? input.aspectRatio : undefined,
    })
    console.log(JSON.stringify({ event: 'generate_image', provider: provider.id, result: 'success', chatId: ctx.chatId }))
    return {
      // The prompt text travels alongside the image (not just in the tool_call input, which
      // the frontend truncates to a short pill label) — the agentic loop's existing text+image
      // tool-result handling threads it through as step.result, so the full prompt renders
      // via the generic result-text fallback with no new frontend code needed.
      entries: [
        { kind: 'text', text: prompt },
        { kind: 'image', format: image.format, bytes: image.bytes },
      ],
      isError: false,
    }
  } catch (err) {
    console.log(JSON.stringify({ event: 'generate_image', provider: provider.id, result: 'error', chatId: ctx.chatId }))
    return { entries: [{ kind: 'text', text: `Image generation failed: ${String(err)}` }], isError: true }
  }
}
