// Façade kept deliberately: `converseStream`/`converseOnce` now dispatch across providers
// (Bedrock Converse for Anthropic, Bedrock Responses for OpenAI — see lib/llm/), but the name is
// still accurate (both go through Bedrock endpoints) and a wide set of call sites — including
// tests/lib/bedrock.test.ts and tests/ws/sendMessage.test.ts's `jest.mock('../../src/lib/bedrock')`
// — import from here. Real implementation lives under lib/llm/.
export { converseStream, converseOnce, HEARTBEAT_INTERVAL_MS, coalesceMessages, healDanglingToolUse, bedrockClient } from './llm/loop'
export type { StreamChunk, TokenUsage, LlmCallContext, LlmPurpose } from './llm/types'
