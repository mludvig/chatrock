#!/usr/bin/env node
// One-off script to validate Fable 5 call conventions on Bedrock.
// Run from the backend/ directory: node scripts/fable5-test.mjs
//
// Fable 5 key differences vs Opus 4.8:
//  - thinking: {type: "disabled"} returns 400 — must OMIT the thinking param entirely
//  - temperature / top_p / top_k removed — all return 400
//  - budget_tokens removed — use thinking: {type: "adaptive"} + output_config.effort
//  - Bedrock profile: global.anthropic.claude-fable-5 (verify via list-inference-profiles)

import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime'

// Verify the profile exists before running:
//   aws bedrock list-inference-profiles --region ap-southeast-2 --type-equals SYSTEM_DEFINED \
//     --query "inferenceProfileSummaries[?contains(inferenceProfileId, 'fable')]"
const MODEL_ID = 'global.anthropic.claude-fable-5'
const REGION   = process.env.AWS_REGION ?? 'ap-southeast-2'

const client = new BedrockRuntimeClient({ region: REGION })

async function streamCall(label, params) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`TEST: ${label}`)
  console.log('─'.repeat(60))
  console.log('Params:', JSON.stringify(params, null, 2))
  console.log()

  try {
    const cmd = new ConverseStreamCommand({ modelId: MODEL_ID, ...params })
    const res = await client.send(cmd)
    if (!res.stream) throw new Error('No stream in response')

    let textOut = ''
    let thinkingOut = ''
    let usage = null

    for await (const event of res.stream) {
      if (event.contentBlockDelta?.delta?.text) {
        textOut += event.contentBlockDelta.delta.text
        process.stdout.write(event.contentBlockDelta.delta.text)
      }
      if (event.contentBlockDelta?.delta?.reasoningContent?.text) {
        thinkingOut += event.contentBlockDelta.delta.reasoningContent.text
      }
      if (event.messageStop) {
        console.log(`\n[stop_reason: ${event.messageStop.stopReason}]`)
      }
      if (event.metadata?.usage) {
        usage = event.metadata.usage
      }
    }

    console.log('\n✅  PASSED')
    if (thinkingOut) console.log(`   thinking tokens (approx chars): ${thinkingOut.length}`)
    if (usage) console.log(`   usage: in=${usage.inputTokens} out=${usage.outputTokens}`)
  } catch (err) {
    console.log(`\n❌  FAILED: ${err.name}: ${err.message}`)
  }
}

// ── Test 1: Basic call — no thinking params at all (Fable 5 safe default) ─────
await streamCall('Basic call (omit thinking param entirely)', {
  messages: [{ role: 'user', content: [{ text: 'Say "Hello from Fable 5" and nothing else.' }] }],
  inferenceConfig: { maxTokens: 32 },
})

// ── Test 2: With adaptive thinking + effort ────────────────────────────────────
await streamCall('Adaptive thinking + effort:high', {
  messages: [{ role: 'user', content: [{ text: 'What is 7 * 8? Answer with just the number.' }] }],
  inferenceConfig: { maxTokens: 512 },
  additionalModelRequestFields: {
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
  },
})

// ── Test 3: With system prompt ─────────────────────────────────────────────────
await streamCall('System prompt + adaptive thinking', {
  system: [{ text: 'You are a concise assistant. Reply in one sentence maximum.' }],
  messages: [{ role: 'user', content: [{ text: 'What is the capital of France?' }] }],
  inferenceConfig: { maxTokens: 128 },
  additionalModelRequestFields: {
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
  },
})

// ── Test 4: Verify thinking:disabled returns 400 (Fable 5 breaking change) ────
await streamCall('EXPECT 400: thinking:{type:"disabled"} — Fable 5 breaking change', {
  messages: [{ role: 'user', content: [{ text: 'Hello' }] }],
  inferenceConfig: { maxTokens: 32 },
  additionalModelRequestFields: {
    thinking: { type: 'disabled' },
  },
})

// ── Test 5: Verify temperature returns 400 ─────────────────────────────────────
await streamCall('EXPECT 400: temperature param — removed on Fable 5', {
  messages: [{ role: 'user', content: [{ text: 'Hello' }] }],
  inferenceConfig: { maxTokens: 32, temperature: 0.7 },
})

console.log('\n' + '═'.repeat(60))
console.log('Done. Tests 1–3 should PASS, tests 4–5 should show 400 errors.')
