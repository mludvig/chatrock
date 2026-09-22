import { MODELS, DEFAULT_CHAT_MODEL, TITLE_MODEL, MEMORY_EXTRACTION_MODEL, getCapabilities, resolveModelId, currentModelId } from '../../src/config/models'

test('MODELS list is non-empty and has required fields', () => {
  expect(MODELS.length).toBeGreaterThan(0)
  for (const m of MODELS) {
    expect(typeof m.id).toBe('string')
    expect(typeof m.name).toBe('string')
  }
})

test('DEFAULT_CHAT_MODEL is in MODELS list', () => {
  expect(MODELS.find(m => m.id === DEFAULT_CHAT_MODEL)).toBeTruthy()
})

test('TITLE_MODEL is a non-empty string', () => {
  expect(typeof TITLE_MODEL).toBe('string')
  expect(TITLE_MODEL.length).toBeGreaterThan(0)
})

test('all current models have attachments capability, except known exceptions', () => {
  // global.xai.grok-4.6: image blocks 500/503 on Bedrock Converse as of Aug 2026 despite
  // the model card listing IMAGE input — see the comment in config/models.ts.
  const KNOWN_EXCEPTIONS = ['global.xai.grok-4.6']
  for (const m of MODELS) {
    if (KNOWN_EXCEPTIONS.includes(m.id)) continue
    expect(m.capabilities.attachments).toBe(true)
  }
})

test('getCapabilities fallback has attachments true', () => {
  expect(getCapabilities('unknown-model').attachments).toBe(true)
})

test('MEMORY_EXTRACTION_MODEL is a non-empty string', () => {
  expect(typeof MEMORY_EXTRACTION_MODEL).toBe('string')
  expect(MEMORY_EXTRACTION_MODEL.length).toBeGreaterThan(0)
})

test('MEMORY_EXTRACTION_MODEL matches one of the known model IDs', () => {
  expect(MODELS.find(m => m.id === MEMORY_EXTRACTION_MODEL)).toBeTruthy()
})

// ── Retired models hand off to a successor (docs/adr/0050-retired-models-hand-off-to-a-successor.md)

test('resolveModelId keeps a live model id unchanged', () => {
  expect(resolveModelId(DEFAULT_CHAT_MODEL)).toEqual({ model: DEFAULT_CHAT_MODEL })
})

test('resolveModelId hands a retired id to the model that replaces it', () => {
  expect(resolveModelId('global.anthropic.claude-opus-5')).toEqual({
    model: 'global.anthropic.claude-opus-5-5', migratedFrom: 'global.anthropic.claude-opus-5',
  })
  expect(resolveModelId('global.openai.gpt-5.6-sol').model).toBe('global.openai.gpt-6-sol')
  expect(resolveModelId('global.openai.gpt-5.6-luna').model).toBe('global.openai.gpt-6-luna')
})

test('resolveModelId falls back to DEFAULT_CHAT_MODEL for an id nothing replaces', () => {
  expect(resolveModelId('no.such.model')).toEqual({ model: DEFAULT_CHAT_MODEL, migratedFrom: 'no.such.model' })
})

test('currentModelId returns a live id or its successor, never the default', () => {
  expect(currentModelId(DEFAULT_CHAT_MODEL)).toBe(DEFAULT_CHAT_MODEL)
  expect(currentModelId('global.anthropic.claude-opus-5')).toBe('global.anthropic.claude-opus-5-5')
  expect(currentModelId('no.such.model')).toBeUndefined()
})

test('no replaces entry is a live model id', () => {
  const live = new Set(MODELS.map(m => m.id))
  for (const m of MODELS) for (const old of m.replaces ?? []) expect(live.has(old)).toBe(false)
})

test('no retired id is replaced by two models', () => {
  const all = MODELS.flatMap(m => m.replaces ?? [])
  expect(new Set(all).size).toBe(all.length)
})
