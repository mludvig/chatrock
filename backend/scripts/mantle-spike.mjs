#!/usr/bin/env node
// One-off script to validate Amazon Bedrock Mantle (OpenAI Responses API) calling
// conventions against a real GPT-5.6 model before building the provider adapter.
// Run from the backend/ directory: node scripts/mantle-spike.mjs
// Uses the default AWS credential chain (SigV4, service `bedrock-mantle`) — set
// AWS_PROFILE / AWS_REGION as needed. No Bedrock bearer token required.
//
// Findings feed llm/providers/mantleTranslate.ts and llm/providers/bedrockMantle.ts.
//
// CONFIRMED FINDINGS (2026-08-03, model openai.gpt-5.6-terra, region us-east-1):
//  - SigV4 via `bedrock({ region })` from 'openai/providers/bedrock/aws' works out of the box
//    with the default AWS credential chain (no explicit credentials, no bearer token needed).
//    Plain `OpenAI` client + `provider: bedrock({ region })` — NOT the bearer-only `BedrockOpenAI`
//    class from 'openai/bedrock'.
//  - baseURL auto-derives to https://bedrock-mantle.<region>.api.aws/openai/v1 — the `openai/v1`
//    prefix GPT-5.x needs is already the SDK default. No override required.
//  - SSE event names confirmed: response.created, response.in_progress, response.output_item.added,
//    response.content_part.added, response.output_text.delta, response.output_text.done,
//    response.content_part.done, response.output_item.done, response.completed,
//    response.function_call_arguments.delta, response.function_call_arguments.done,
//    response.incomplete (on max_output_tokens truncation).
//  - reasoning.encrypted_content: present and populated when `include:['reasoning.encrypted_content']`
//    is set, even under store:false. At effort:'max' on a moderate prompt, encrypted_content was
//    ~2.5 KB (2548 base64 chars) — comfortably under the proposed REASONING_OPAQUE_CAP (96 KB), but
//    that was a short response; a long multi-round agentic answer could run much larger. Cap stays
//    a safety net, not the expected common case.
//  - Note: `reasoning.summary` was an empty array in this run even with `summary:'auto'` set —
//    worth re-verifying per-model; the mantleTranslate ThinkingBlock.text should tolerate an empty
//    summary and store the opaque payload regardless (reasoning continuity doesn't require a
//    visible summary to exist).
//  - function_call round-trip confirmed both directions: model emits `call_id` shaped
//    `call_<32-hex>`; a Bedrock-shaped `toolUseId` (e.g. `tooluse_abc123XYZ`) sent back inbound as
//    `function_call.call_id` / `function_call_output.call_id` was accepted without complaint —
//    resolves the "call_id charset" open question, no id-rewriting fallback needed.
//  - The Responses item id (`fc_...`, `rs_...`) is distinct from `call_id` and was never required
//    on input — confirms the "never send previous_response_id / item ids, fully stateless" design.

import { OpenAI } from 'openai'
import { bedrock } from 'openai/providers/bedrock/aws'

const REGION = process.env.AWS_REGION || 'us-east-1'
const MODEL_ID = process.env.MANTLE_MODEL || 'openai.gpt-5.6-terra'

const client = new OpenAI({
  provider: bedrock({ region: REGION }),
})

async function run(label, params) {
  console.log(`\n${'─'.repeat(70)}`)
  console.log(`TEST: ${label}`)
  console.log('─'.repeat(70))
  console.log('baseURL will derive to: https://bedrock-mantle.' + REGION + '.api.aws/openai/v1')
  console.log('Params:', JSON.stringify(params, null, 2))
  try {
    const stream = await client.responses.create({ model: MODEL_ID, stream: true, store: false, ...params })
    const eventTypes = new Set()
    let textOut = ''
    let reasoningOut = ''
    let encryptedLen = 0
    let usage = null
    for await (const event of stream) {
      eventTypes.add(event.type)
      if (event.type === 'response.output_text.delta') textOut += event.delta
      if (event.type === 'response.reasoning_summary_text.delta') reasoningOut += event.delta
      if (event.type === 'response.output_item.done' && event.item?.type === 'reasoning') {
        encryptedLen = event.item.encrypted_content?.length ?? 0
        console.log('\n  reasoning item:', JSON.stringify({ id: event.item.id, has_encrypted: !!event.item.encrypted_content, encrypted_len: encryptedLen, summary: event.item.summary }, null, 2))
      }
      if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
        console.log('\n  function_call item:', JSON.stringify(event.item, null, 2))
      }
      if (event.type === 'response.completed') {
        usage = event.response?.usage
      }
      if (event.type === 'error' || event.type === 'response.failed') {
        console.log('\n  ERROR EVENT:', JSON.stringify(event, null, 2))
      }
    }
    console.log('\nEvent types seen:', [...eventTypes].join(', '))
    if (textOut) console.log('text:', textOut)
    if (reasoningOut) console.log('reasoning summary:', reasoningOut)
    if (usage) console.log('usage:', JSON.stringify(usage))
    console.log('✅  PASSED')
  } catch (err) {
    console.log(`\n❌  FAILED: ${err.name}: ${err.message}`)
    if (err.status) console.log('   status:', err.status)
    if (err.error) console.log('   error body:', JSON.stringify(err.error))
  }
}

// ── Test 1: basic streaming text, no reasoning ─────────────────────────────────
await run('Basic streaming text', {
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'Say "Hello from Mantle" and nothing else.' }] }],
  max_output_tokens: 64,
})

// ── Test 2: reasoning effort + encrypted_content round-trip ────────────────────
await run('Reasoning effort:low + encrypted_content included', {
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'What is 7 * 8? Think briefly then answer with just the number.' }] }],
  reasoning: { effort: 'low', summary: 'auto' },
  include: ['reasoning.encrypted_content'],
  max_output_tokens: 512,
})

// ── Test 3: reasoning effort:max — check encrypted_content size ────────────────
await run('Reasoning effort:max — payload size check', {
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'Explain step by step how you would sort a large list efficiently, considering multiple algorithms.' }] }],
  reasoning: { effort: 'max', summary: 'auto' },
  include: ['reasoning.encrypted_content'],
  max_output_tokens: 2048,
})

// ── Test 4: function calling ────────────────────────────────────────────────────
await run('Function calling', {
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'What is the weather in Wellington, NZ? Use the get_weather tool.' }] }],
  tools: [{ type: 'function', name: 'get_weather', description: 'Get current weather for a location', parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] }, strict: false }],
  max_output_tokens: 256,
})

// ── Test 5: system instructions ─────────────────────────────────────────────────
await run('Instructions (system prompt equivalent)', {
  instructions: 'You are a concise assistant. Reply in one sentence maximum.',
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'What is the capital of France?' }] }],
  max_output_tokens: 128,
})

console.log('\n' + '═'.repeat(70))
console.log('Done. Review event type names, encrypted_content sizes, and any FAILED tests above.')
