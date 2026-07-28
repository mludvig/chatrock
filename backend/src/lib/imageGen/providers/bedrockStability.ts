import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import type { GeneratedImage, ImageGenRequest, ImageProvider } from '../registry'
import { ensureBedrockAuth } from '../../bedrockAuth'

// Stability's Stable Image models are only offered as an on-demand Bedrock foundation model
// in us-west-2 as of July 2026 — confirmed absent from ap-southeast-2 (where this backend
// otherwise runs), us-east-1, and eu-west-1 via `aws bedrock list-foundation-models
// --by-provider stability-ai --region <region>`. This client is deliberately pinned to
// us-west-2, separate from the ap-southeast-2 client bedrock.ts uses for Claude. It's a plain
// cross-region InvokeModel call, not a cross-region inference profile — image models don't
// have those (see model-lifecycle/global.* gotcha in root CLAUDE.md, which is Claude-specific).
const REGION = 'us-west-2'
const MODEL_ID = 'stability.stable-image-ultra-v1:1'

export const stabilityClient = new BedrockRuntimeClient({ region: REGION })

// Per Stability's Bedrock request schema (docs.aws.amazon.com/bedrock, "Stable Image Ultra
// request and response") — text-to-image mode only, no imageto-image needed here.
const ASPECT_RATIOS = ['16:9', '1:1', '21:9', '2:3', '3:2', '4:5', '5:4', '9:16', '9:21']

interface StabilityInvokeBody {
  prompt: string
  negative_prompt?: string
  aspect_ratio?: string
  output_format: 'png' | 'jpeg'
}

interface StabilityResponse {
  images?: string[]
  finish_reasons?: (string | null)[]
}

export const bedrockStabilityProvider: ImageProvider = {
  id: 'bedrock-stability',
  name: 'Stability AI (Bedrock)',
  supportsNegativePrompt: true,
  aspectRatios: ASPECT_RATIOS,
  promptGuidance: "This model does not expand or rewrite short prompts — write a rich, self-contained visual description covering subject, composition, style, and lighting. Use negativePrompt for elements to keep out of frame rather than phrasing them as exclusions in the main prompt.",

  async generate(req: ImageGenRequest): Promise<GeneratedImage> {
    const body: StabilityInvokeBody = { prompt: req.prompt, output_format: 'png' }
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt
    if (req.aspectRatio && ASPECT_RATIOS.includes(req.aspectRatio)) body.aspect_ratio = req.aspectRatio

    await ensureBedrockAuth()
    const res = await stabilityClient.send(new InvokeModelCommand({
      modelId: MODEL_ID,
      body: JSON.stringify(body),
      contentType: 'application/json',
      accept: 'application/json',
    }))

    const parsed = JSON.parse(new TextDecoder().decode(res.body)) as StabilityResponse
    const finishReason = parsed.finish_reasons?.[0]
    if (finishReason) throw new Error(`Image generation failed: ${finishReason}`)
    const image = parsed.images?.[0]
    if (!image) throw new Error('Image generation returned no image')

    return { bytes: Buffer.from(image, 'base64'), format: 'png' }
  },
}
