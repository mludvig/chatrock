import { assembleSystemPrompt } from '../../src/lib/promptAssembly'

// ── assembleSystemPrompt ──────────────────────────────────────────────────────

test('persona is first, base prompt is last', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base instructions.',
    prefs: { persona: 'You are a pirate.' },
    memories: [],
  })
  const personaIdx = result.indexOf('You are a pirate.')
  const baseIdx = result.indexOf('Base instructions.')
  expect(personaIdx).toBeGreaterThanOrEqual(0)
  expect(baseIdx).toBeGreaterThanOrEqual(0)
  expect(personaIdx).toBeLessThan(baseIdx)
})

test('empty persona → persona section absent', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base.',
    prefs: { persona: '' },
    memories: [],
  })
  // Should just have base prompt, no blank leading section
  expect(result.trim()).toBe('Base.')
})

test('whitespace-only persona → persona section absent', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base.',
    prefs: { persona: '   ' },
    memories: [],
  })
  expect(result.trim()).toBe('Base.')
})

test('undefined persona → persona section absent', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base.',
    prefs: {},
    memories: [],
  })
  expect(result.trim()).toBe('Base.')
})

test('injectCurrentDate=true + now → date line present', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: { injectCurrentDate: true },
    memories: [],
    now: '2026-06-14T10:00:00.000Z',
  })
  expect(result).toContain("Today's date is 2026-06-14.")
})

test('injectCurrentDate=false → date line absent', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: { injectCurrentDate: false },
    memories: [],
    now: '2026-06-14T10:00:00.000Z',
  })
  expect(result).not.toContain("Today's date is")
})

test('injectCurrentDate=true but no now → date line absent', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: { injectCurrentDate: true },
    memories: [],
    // now is undefined
  })
  expect(result).not.toContain("Today's date is")
})

test('answerLength=short → concise directive present', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: { answerLength: 'short' },
    memories: [],
  })
  expect(result).toContain('concise')
})

test('answerLength=extensive → detailed directive present', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: { answerLength: 'extensive' },
    memories: [],
  })
  expect(result).toContain('detailed')
})

test('answerLength=default → neither concise nor detailed directive', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: { answerLength: 'default' },
    memories: [],
  })
  expect(result).not.toContain('concise')
  expect(result).not.toContain('detailed')
})

test('memories populated → memory block present with each fact', () => {
  const memories = [
    { text: 'User likes TypeScript', category: 'preference' },
    { text: 'User is based in Auckland', category: 'location' },
  ]
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories,
  })
  expect(result).toContain('What you know about the user:')
  expect(result).toContain('User likes TypeScript')
  expect(result).toContain('User is based in Auckland')
})

test('empty memories → memory block absent', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base.',
    prefs: {},
    memories: [],
  })
  expect(result).not.toContain('What you know about the user:')
})

test('all empty → returns empty string', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [],
  })
  expect(result).toBe('')
})

test('base prompt only → returns base prompt trimmed', () => {
  const result = assembleSystemPrompt({
    basePrompt: '  Only base.  ',
    prefs: {},
    memories: [],
  })
  expect(result).toBe('Only base.')
})

test('all parts together → correct ordering: persona → date → length → memory → base', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base prompt here.',
    prefs: {
      persona: 'You are an expert.',
      injectCurrentDate: true,
      answerLength: 'short',
    },
    memories: [{ text: 'User is a developer', category: 'role' }],
    now: '2026-06-14T10:00:00.000Z',
  })

  const personaIdx = result.indexOf('You are an expert.')
  const dateIdx = result.indexOf("Today's date is 2026-06-14.")
  const lengthIdx = result.indexOf('concise')
  const memoryIdx = result.indexOf('What you know about the user:')
  const baseIdx = result.indexOf('Base prompt here.')

  expect(personaIdx).toBeGreaterThanOrEqual(0)
  expect(dateIdx).toBeGreaterThanOrEqual(0)
  expect(lengthIdx).toBeGreaterThanOrEqual(0)
  expect(memoryIdx).toBeGreaterThanOrEqual(0)
  expect(baseIdx).toBeGreaterThanOrEqual(0)

  expect(personaIdx).toBeLessThan(dateIdx)
  expect(dateIdx).toBeLessThan(lengthIdx)
  expect(lengthIdx).toBeLessThan(memoryIdx)
  expect(memoryIdx).toBeLessThan(baseIdx)
})

test('memory block is placed before base prompt', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base.',
    prefs: {},
    memories: [{ text: 'User prefers brevity', category: 'style' }],
  })
  const memIdx = result.indexOf('What you know about the user:')
  const baseIdx = result.indexOf('Base.')
  expect(memIdx).toBeLessThan(baseIdx)
})

test('date line uses only YYYY-MM-DD portion of ISO string', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: { injectCurrentDate: true },
    memories: [],
    now: '2026-06-14T23:59:59.999Z',
  })
  expect(result).toContain("Today's date is 2026-06-14.")
  expect(result).not.toContain('T23:59:59')
})

// ── memId support in memory block ────────────────────────────────────────────

test('memories with memId → [memId] bracket rendered in memory lines', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [
      { memId: 'abc123', text: 'User likes TypeScript', category: 'preference' },
    ],
  })
  expect(result).toContain('[abc123]')
  expect(result).toContain('User likes TypeScript')
})

test('memories without memId → lines still render without brackets (backward compat)', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [
      { text: 'User is a developer', category: 'identity' },
    ],
  })
  expect(result).toContain('User is a developer')
  // No [undefined] or [?] artefacts
  expect(result).not.toContain('[undefined]')
  expect(result).not.toContain('[?]')
})

test('memoryToolEnabled:true with memories → capability sentence present AND memIds in lines', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [
      { memId: 'id-1', text: 'User likes Python', category: 'preference' },
    ],
    memoryToolEnabled: true,
  })
  expect(result).toContain('[id-1]')
  expect(result).toContain('manage_memory')
  expect(result).toContain('remember')
})

test('memoryToolEnabled:false with memories → memIds in lines but NO capability sentence', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [
      { memId: 'id-1', text: 'User likes Python', category: 'preference' },
    ],
    memoryToolEnabled: false,
  })
  expect(result).toContain('[id-1]')
  expect(result).not.toContain('manage_memory')
})

test('empty memories + memoryToolEnabled:true → "currently empty" header + capability sentence', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [],
    memoryToolEnabled: true,
  })
  expect(result).toContain('currently empty')
  expect(result).toContain('manage_memory')
})

test('empty memories + memoryToolEnabled:false (or absent) → memory block absent', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base.',
    prefs: {},
    memories: [],
    memoryToolEnabled: false,
  })
  expect(result).not.toContain('What you know about the user:')
  expect(result).not.toContain('currently empty')
  expect(result).not.toContain('manage_memory')
})
