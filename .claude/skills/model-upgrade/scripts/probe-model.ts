// Live capability probe for one model, run through chatrock's own provider adapters
// (getProvider(modelId).streamTurn / .once), so it exercises exactly the request shapes
// the app sends — not a hand-written approximation of them.
//
// Usage (via probe.sh, which bundles this with esbuild and loads the root .env):
//   probe.sh <modelId> [--caps '<json>'] [--only name,name]
//
// --caps merges into the model's MODELS entry (or registers a temporary one if the id is
// not in the registry yet), e.g. --caps '{"provider":"bedrock-converse","thinkingOff":"disabled"}'.
// Re-run with different --caps to find which value the model accepts.

import { readFileSync } from 'fs'
import path from 'path'
import { MODELS, getCapabilities, type ModelCapabilities, type ThinkingEffort } from '../../../../backend/src/config/models'
import { getProvider } from '../../../../backend/src/lib/llm/registry'
import type { NeutralMessage, Block } from '../../../../backend/src/lib/llm/blocks'
import type { ToolSpec } from '../../../../backend/src/lib/llm/toolSpec'
import type { StreamChunk, TurnRequest, TurnResult } from '../../../../backend/src/lib/llm/types'

const args = process.argv.slice(2)
const modelId = args[0]
if (!modelId || modelId.startsWith('--')) {
  console.error("Usage: probe.sh <modelId> [--caps '<json>'] [--only name,name]")
  process.exit(2)
}
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const capsOverride: Partial<ModelCapabilities> = JSON.parse(flag('--caps') ?? '{}')
const only = flag('--only')?.split(',')

const existing = MODELS.find(m => m.id === modelId)
if (existing) {
  Object.assign(existing.capabilities, capsOverride)
} else {
  MODELS.push({
    id: modelId,
    name: `probe:${modelId}`,
    capabilities: {
      provider: 'bedrock-responses', thinking: 'effort', attachments: true, pdf: true,
      promptCaching: 'explicit', maxOutputTokens: 16000, ...capsOverride,
    } as ModelCapabilities,
  })
}
const caps = getCapabilities(modelId)
const provider = getProvider(modelId)

// ── Fixtures ──────────────────────────────────────────────────────────────────

const repoRoot = path.resolve(process.env.REPO_ROOT ?? '.')
// A real icon, not a 1x1 pixel: GPT silently ignores tiny images. It is predominantly blue.
const PNG = new Uint8Array(readFileSync(path.join(repoRoot, 'frontend/public/icon-192.png')))

function makePdf(text: string): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, // content stream, filled below
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  out += offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}
const PDF = makePdf('The secret word is PELICAN.')
const TXT = new TextEncoder().encode('The secret word is HERON.\n')

const WEATHER_TOOL: ToolSpec = {
  name: 'get_weather',
  description: 'Get the current temperature in a city, in degrees Celsius.',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}
const SCREENSHOT_TOOL: ToolSpec = {
  name: 'take_screenshot',
  description: 'Take a screenshot of a web page.',
  inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
}
// Comfortably over every provider's minimum cacheable prefix (1024-4096 tokens).
const LONG_SYSTEM = 'You are a terse assistant. ' + Array.from({ length: 600 }, (_, i) => `Rule ${i}: answer briefly.`).join(' ')

const user = (...content: Block[]): NeutralMessage => ({ role: 'user', content })
const text = (t: string): Block => ({ kind: 'text', text: t })

// ── Runner ────────────────────────────────────────────────────────────────────

interface Run { chunks: StreamChunk[]; result: TurnResult; text: string; thinking: string }

async function turn(over: Partial<TurnRequest> & { messages: NeutralMessage[] }): Promise<Run> {
  const req: TurnRequest = {
    modelId, systemPrompt: 'You are a terse assistant.', tools: [], cacheBoundaryIndex: -1,
    settings: { thinkingEffort: caps.thinking === 'none' ? undefined : 'low' }, ...over,
  }
  const gen = provider.streamTurn({ ...req, messages: provider.sanitizeHistory(req.messages) })
  const chunks: StreamChunk[] = []
  for (;;) {
    const r = await gen.next()
    if (r.done) {
      const t = chunks.filter(c => c.type === 'delta').map(c => (c as { text: string }).text).join('')
      const th = chunks.filter(c => c.type === 'thinking_delta').map(c => (c as { text: string }).text).join('')
      return { chunks, result: r.value, text: t, thinking: th }
    }
    chunks.push(r.value)
  }
}

type Outcome = { status: 'PASS' | 'WEAK' | 'FAIL'; detail: string }
const pass = (ok: boolean, detail: string): Outcome => ({ status: ok ? 'PASS' : 'WEAK', detail })
const short = (s: string, n = 90) => s.replace(/\s+/g, ' ').trim().slice(0, n)
const usageStr = (r: TurnResult) => r.usage
  ? `in=${r.usage.inputTokens} out=${r.usage.outputTokens} cacheRead=${r.usage.cacheReadInputTokens ?? 0} cacheWrite=${r.usage.cacheWriteInputTokens ?? 0}`
  : 'no usage'

// Asks for a tool call, then answers it with `entries`, returning the final answer turn.
async function toolRoundTrip(tool: ToolSpec, prompt: string, entries: Extract<Block, { kind: 'tool_result' }>['entries']) {
  const first = await turn({ messages: [user(text(prompt))], tools: [tool] })
  const call = first.result.content.find(b => b.kind === 'tool_call')
  if (!call || call.kind !== 'tool_call') return { first, final: undefined }
  const final = await turn({
    tools: [tool],
    messages: [
      user(text(prompt)),
      { role: 'assistant', content: first.result.content },
      user({ kind: 'tool_result', callId: call.callId, name: call.name, entries, isError: false }),
    ],
  })
  return { first, final }
}

const probes: Record<string, () => Promise<Outcome>> = {
  text: async () => {
    const r = await turn({ messages: [user(text('Reply with exactly the word PONG.'))] })
    return pass(/PONG/.test(r.text), `"${short(r.text)}" ${usageStr(r.result)}`)
  },
  image: async () => {
    const r = await turn({ messages: [user(text('List every colour you can see in this image, comma-separated.'), { kind: 'image', image: { format: 'png', source: { bytes: PNG } } })] })
    return pass(/blue/i.test(r.text), `"${short(r.text)}" (expect blue)`)
  },
  document_pdf: async () => {
    const r = await turn({ messages: [user(text('What is the secret word in the attached PDF? One word.'), { kind: 'document', document: { format: 'pdf', name: 'secret.pdf', source: { bytes: PDF } } })] })
    return pass(/PELICAN/i.test(r.text), `"${short(r.text)}" (expect PELICAN)`)
  },
  document_txt: async () => {
    const r = await turn({ messages: [user(text('What is the secret word in the attached file? One word.'), { kind: 'document', document: { format: 'txt', name: 'secret.txt', source: { bytes: TXT } } })] })
    return pass(/HERON/i.test(r.text), `"${short(r.text)}" (expect HERON)`)
  },
  tool_roundtrip: async () => {
    const { first, final } = await toolRoundTrip(WEATHER_TOOL, 'What is the temperature in Wellington right now? Use the tool.', [{ kind: 'text', text: '{"tempC": 17}' }])
    if (!final) return { status: 'WEAK', detail: `no tool call; said "${short(first.text)}"` }
    return pass(/17/.test(final.text), `"${short(final.text)}" (expect 17)`)
  },
  tool_result_image: async () => {
    const { first, final } = await toolRoundTrip(SCREENSHOT_TOOL, 'Screenshot https://example.com and list every colour you can see in it, comma-separated.', [{ kind: 'text', text: 'Screenshot attached.' }, { kind: 'image', image: { format: 'png', source: { bytes: PNG } } }])
    if (!final) return { status: 'WEAK', detail: `no tool call; said "${short(first.text)}"` }
    return pass(/blue/i.test(final.text), `"${short(final.text)}" (expect blue)`)
  },
  forced_tool: async () => {
    const r = await turn({ messages: [user(text('Hello there.'))], tools: [WEATHER_TOOL, SCREENSHOT_TOOL], forceToolName: 'get_weather' })
    const call = r.result.content.find(b => b.kind === 'tool_call')
    return pass(call?.kind === 'tool_call' && call.name === 'get_weather', call?.kind === 'tool_call' ? `called ${call.name}` : `no call; "${short(r.text)}"`)
  },
  forced_tool_thinking_high: async () => {
    const r = await turn({ messages: [user(text('Hello there.'))], tools: [WEATHER_TOOL, SCREENSHOT_TOOL], forceToolName: 'get_weather', settings: { thinkingEffort: 'high' } })
    const call = r.result.content.find(b => b.kind === 'tool_call')
    return pass(call?.kind === 'tool_call' && call.name === 'get_weather', call?.kind === 'tool_call' ? `called ${call.name}` : `no call; "${short(r.text)}"`)
  },
  ...Object.fromEntries((['off', 'low', 'medium', 'high', 'max'] as ThinkingEffort[]).map(level => [`thinking_${level}`, async (): Promise<Outcome> => {
    const r = await turn({ messages: [user(text('A bat and a ball cost 1.10 together; the bat costs 1.00 more than the ball. Then: is 7919 * 7907 + 2 divisible by 3? Give both answers only.'))], settings: { thinkingEffort: level } })
    const thought = r.chunks.some(c => c.type === 'thinking_delta') || r.result.content.some(b => b.kind === 'thinking')
    // out= includes hidden reasoning tokens on Responses, so it rising with the level shows the dial works.
    return { status: 'PASS', detail: `accepted; thinking ${thought ? 'present' : 'absent'} (${r.thinking.length} chars) out=${r.result.usage?.outputTokens ?? '?'}` }
  }])),
  reasoning_replay: async () => {
    const q = user(text('Think of a number between 1 and 10, tell me only its parity.'))
    const first = await turn({ messages: [q], settings: { thinkingEffort: 'medium' } })
    const opaque = first.result.content.some(b => b.kind === 'thinking' && b.opaque)
    const second = await turn({ messages: [q, { role: 'assistant', content: first.result.content }, user(text('Now tell me the number.'))], settings: { thinkingEffort: 'medium' } })
    return { status: 'PASS', detail: `follow-up accepted (stored reasoning opaque: ${opaque ? 'yes' : 'no'}): "${short(second.text, 50)}"` }
  },
  caching: async () => {
    const messages = [user(text('Say OK.'))]
    const a = await turn({ systemPrompt: LONG_SYSTEM, messages, cacheBoundaryIndex: 0 })
    const b = await turn({ systemPrompt: LONG_SYSTEM, messages, cacheBoundaryIndex: 0 })
    const hit = (b.result.usage?.cacheReadInputTokens ?? 0) > 0
    return pass(hit, `1st: ${usageStr(a.result)} | 2nd: ${usageStr(b.result)}`)
  },
  // A cache marker right after a document was once a hard ValidationException on Converse.
  caching_after_document: async () => {
    const messages = [user(text('Say OK.'), { kind: 'document', document: { format: 'txt', name: 'secret.txt', source: { bytes: TXT } } }), { role: 'assistant' as const, content: [text('OK.')] }, user(text('Say OK again.'))]
    const r = await turn({ systemPrompt: LONG_SYSTEM, messages, cacheBoundaryIndex: 1 })
    return { status: 'PASS', detail: `accepted; ${usageStr(r.result)}` }
  },
  once: async () => {
    const r = await provider.once({ modelId, systemPrompt: 'Reply with a three-word title.', messages: [user(text('A chat about baking sourdough bread at home.'))], maxTokens: 64 })
    return pass(r.text.trim().length > 0, `"${short(r.text)}" ${r.usage ? `out=${r.usage.outputTokens}` : ''}`)
  },
}

async function main() {
  console.log(`# Probe: ${modelId}\n\ncaps: ${JSON.stringify(caps)}\n`)
  const names = Object.keys(probes).filter(n => !only || only.includes(n))
  const results = await Promise.all(names.map(async name => {
    const t0 = Date.now()
    try {
      return { name, ...(await probes[name]()), ms: Date.now() - t0 }
    } catch (err) {
      const e = err as { name?: string; status?: number; message?: string }
      return { name, status: 'FAIL' as const, detail: `${e.name ?? 'Error'}${e.status ? ` ${e.status}` : ''}: ${short(e.message ?? String(err), 200)}`, ms: Date.now() - t0 }
    }
  }))
  console.log('| probe | result | ms | detail |\n| --- | --- | --- | --- |')
  for (const r of results) console.log(`| ${r.name} | ${r.status} | ${r.ms} | ${r.detail.replace(/\|/g, '\\|')} |`)
}

main().catch(err => { console.error(err); process.exit(1) })
