import { MODELS, DEFAULT_CHAT_MODEL, TITLE_MODEL, MEMORY_EXTRACTION_MODEL, getCapabilities } from '../../src/config/models'

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

test('all current models have attachments capability', () => {
  for (const m of MODELS) {
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
