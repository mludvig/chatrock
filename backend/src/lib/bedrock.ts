import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  ConverseCommand,
  type Message,
} from '@aws-sdk/client-bedrock-runtime'

export const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION ?? 'ap-southeast-2',
})

export interface StreamChunk {
  type: 'delta' | 'stop'
  text?: string
  stopReason?: string
}

export async function* converseStream(
  modelId: string,
  systemPrompt: string,
  messages: Message[],
): AsyncGenerator<StreamChunk> {
  const cmd = new ConverseStreamCommand({
    modelId,
    system: systemPrompt ? [{ text: systemPrompt }] : undefined,
    messages,
    inferenceConfig: { maxTokens: 4096 },
  })
  const res = await bedrockClient.send(cmd)
  if (!res.stream) throw new Error('No stream in Bedrock response')

  for await (const event of res.stream) {
    if (event.contentBlockDelta?.delta?.text) {
      yield { type: 'delta', text: event.contentBlockDelta.delta.text }
    }
    if (event.messageStop) {
      yield { type: 'stop', stopReason: event.messageStop.stopReason ?? 'end_turn' }
    }
  }
}

export async function converseOnce(
  modelId: string,
  systemPrompt: string,
  messages: Message[],
): Promise<string> {
  const cmd = new ConverseCommand({
    modelId,
    system: systemPrompt ? [{ text: systemPrompt }] : undefined,
    messages,
    inferenceConfig: { maxTokens: 64 },
  })
  const res = await bedrockClient.send(cmd)
  const block = res.output?.message?.content?.[0]
  if (block && 'text' in block) return (block.text ?? '').trim()
  return ''
}
