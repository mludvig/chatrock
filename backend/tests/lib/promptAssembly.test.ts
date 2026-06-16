import { assembleSystemPrompt } from '../../src/lib/promptAssembly'

// ── assembleSystemPrompt ──────────────────────────────────────────────────────

test('basePrompt non-empty → basePrompt used as effective instructions, persona NOT appended', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base instructions.',
    prefs: { persona: 'You are a pirate.' },
    memories: [],
  })
  expect(result).toContain('Base instructions.')
  expect(result).not.toContain('You are a pirate.')
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

test('all parts together → correct ordering: effective-instructions → date → length → memory (basePrompt replaces persona when non-empty)', () => {
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

  // basePrompt is non-empty → it replaces persona as effective instructions
  expect(result).toContain('Base prompt here.')
  expect(result).not.toContain('You are an expert.')

  const baseIdx = result.indexOf('Base prompt here.')
  const dateIdx = result.indexOf("Today's date is 2026-06-14.")
  const lengthIdx = result.indexOf('concise')
  const memoryIdx = result.indexOf('What you know about the user:')

  expect(dateIdx).toBeGreaterThanOrEqual(0)
  expect(lengthIdx).toBeGreaterThanOrEqual(0)
  expect(memoryIdx).toBeGreaterThanOrEqual(0)

  // effective instructions at the top, then date, length, memory
  expect(baseIdx).toBeLessThan(dateIdx)
  expect(dateIdx).toBeLessThan(lengthIdx)
  expect(lengthIdx).toBeLessThan(memoryIdx)
})

test('effective instructions appear before memory block (basePrompt is effective instruction when non-empty)', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base.',
    prefs: {},
    memories: [{ text: 'User prefers brevity', category: 'style' }],
  })
  const baseIdx = result.indexOf('Base.')
  const memIdx = result.indexOf('What you know about the user:')
  // basePrompt is the effective instruction → it appears first, memory follows
  expect(baseIdx).toBeLessThan(memIdx)
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

// ── Part B: effective instructions collapse (persona + basePrompt) ────────────

test('B-prompt1: per-chat basePrompt non-empty → used as effective instructions, persona NOT appended', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Chat instructions.',
    prefs: { persona: 'Global persona.' },
    memories: [],
  })
  expect(result).toContain('Chat instructions.')
  expect(result).not.toContain('Global persona.')
})

test('B-prompt2: basePrompt empty → persona is used as effective instructions', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: { persona: 'Global persona.' },
    memories: [],
  })
  expect(result).toContain('Global persona.')
})

test('B-prompt3: both basePrompt and persona empty → no instructions block, returns empty string', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: { persona: '' },
    memories: [],
  })
  expect(result).toBe('')
})

// ── projectInstructions ───────────────────────────────────────────────────────

test('projectInstructions injected after effective instructions', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Chat instructions.',
    prefs: {},
    memories: [],
    projectInstructions: 'Project-level instructions.',
  })
  expect(result).toContain('Project instructions:\nProject-level instructions.')
  const chatIdx = result.indexOf('Chat instructions.')
  const projIdx = result.indexOf('Project instructions:')
  expect(chatIdx).toBeLessThan(projIdx)
})

test('projectInstructions not injected when absent', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base.',
    prefs: {},
    memories: [],
  })
  expect(result).not.toContain('Project instructions:')
})

test('projectInstructions not injected when empty string', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base.',
    prefs: {},
    memories: [],
    projectInstructions: '',
  })
  expect(result).not.toContain('Project instructions:')
})

test('projectInstructions not injected when whitespace-only', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base.',
    prefs: {},
    memories: [],
    projectInstructions: '   ',
  })
  expect(result).not.toContain('Project instructions:')
})

// ── projectMemories ───────────────────────────────────────────────────────────

test('projectMemories populated → project memory block present with header and items', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [],
    projectMemories: [
      { memId: 'pm-1', text: 'Project uses TypeScript', category: 'tech' },
      { memId: 'pm-2', text: 'Target is AWS Lambda', category: 'infra' },
    ],
  })
  expect(result).toContain('What you know about this project:')
  expect(result).toContain('[pm-1]')
  expect(result).toContain('Project uses TypeScript')
  expect(result).toContain('[pm-2]')
  expect(result).toContain('Target is AWS Lambda')
})

test('projectMemories without memId → lines render without brackets', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [],
    projectMemories: [
      { text: 'Project uses TypeScript', category: 'tech' },
    ],
  })
  expect(result).toContain('Project uses TypeScript')
  expect(result).not.toContain('[undefined]')
  expect(result).not.toContain('[?]')
})

test('projectMemoryToolEnabled:true with memories → capability sentence present', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [],
    projectMemories: [
      { memId: 'pm-1', text: 'Project uses TypeScript', category: 'tech' },
    ],
    projectMemoryToolEnabled: true,
  })
  expect(result).toContain('manage_project_memory')
  expect(result).toContain('remember')
  expect(result).toContain('shared across all chats in this project')
})

test('projectMemoryToolEnabled:false with memories → NO capability sentence', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [],
    projectMemories: [
      { memId: 'pm-1', text: 'Project uses TypeScript', category: 'tech' },
    ],
    projectMemoryToolEnabled: false,
  })
  expect(result).toContain('What you know about this project:')
  expect(result).not.toContain('manage_project_memory')
})

test('empty projectMemories + projectMemoryToolEnabled:true → "currently empty" header + capability', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [],
    projectMemories: [],
    projectMemoryToolEnabled: true,
  })
  expect(result).toContain('currently empty')
  expect(result).toContain('manage_project_memory')
})

test('empty projectMemories + projectMemoryToolEnabled absent → project memory block absent', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base.',
    prefs: {},
    memories: [],
    projectMemories: [],
  })
  expect(result).not.toContain('What you know about this project:')
  expect(result).not.toContain('currently empty')
  expect(result).not.toContain('manage_project_memory')
})

test('projectMemories and projectMemoryToolEnabled both absent → project memory block absent', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base.',
    prefs: {},
    memories: [],
  })
  expect(result).not.toContain('What you know about this project:')
  expect(result).not.toContain('manage_project_memory')
})

// ── projectManifest ───────────────────────────────────────────────────────────

test('projectManifest with files + chats → manifest block present with fileIds and chatIds and navigational warning', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [],
    projectManifest: {
      files: [
        { fileId: 'file-1', name: 'README.md', microLabel: 'overview', inclusion: 'manual' },
        { fileId: 'file-2', name: 'schema.sql', inclusion: 'manual' },
      ],
      chats: [
        { chatId: 'chat-1', title: 'Architecture discussion', summary: 'We discussed the system design.' },
        { chatId: 'chat-2', title: 'Bug triage' },
      ],
    },
    projectReadToolsEnabled: true,
  })
  expect(result).toContain('Project context you can consult:')
  expect(result).toContain('[file-1]')
  expect(result).toContain('README.md')
  expect(result).toContain('overview')
  expect(result).toContain('[file-2]')
  expect(result).toContain('schema.sql')
  expect(result).toContain('[chat-1]')
  expect(result).toContain('Architecture discussion')
  expect(result).toContain('[chat-2]')
  expect(result).toContain('Bug triage')
  expect(result).toContain('NAVIGATIONAL ONLY')
  expect(result).toContain('read_project_file')
})

test('projectManifest with files only → "Other chats" section absent', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [],
    projectManifest: {
      files: [{ fileId: 'file-1', name: 'README.md', inclusion: 'manual' }],
      chats: [],
    },
  })
  expect(result).toContain('[file-1]')
  expect(result).not.toContain('Other chats in this project')
})

test('projectManifest with chats only → "Files" section absent', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [],
    projectManifest: {
      files: [],
      chats: [{ chatId: 'chat-1', title: 'Planning session' }],
    },
  })
  expect(result).toContain('[chat-1]')
  expect(result).not.toContain('Files (you currently see labels only')
})

test('projectManifest present but projectReadToolsEnabled:false → manifest block present but no "Use read_project_file" sentence', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [],
    projectManifest: {
      files: [{ fileId: 'file-1', name: 'spec.md', inclusion: 'manual' }],
      chats: [],
    },
    projectReadToolsEnabled: false,
  })
  expect(result).toContain('NAVIGATIONAL ONLY')
  expect(result).not.toContain('read_project_file')
})

test('projectManifest present but projectReadToolsEnabled absent → no "Use read_project_file" sentence', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [],
    projectManifest: {
      files: [{ fileId: 'file-1', name: 'spec.md', inclusion: 'manual' }],
      chats: [],
    },
  })
  expect(result).toContain('NAVIGATIONAL ONLY')
  expect(result).not.toContain('read_project_file')
})

test('no projectManifest → no manifest block', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base.',
    prefs: {},
    memories: [],
  })
  expect(result).not.toContain('Project context you can consult:')
  expect(result).not.toContain('NAVIGATIONAL ONLY')
})

test('projectManifest with both empty arrays → no manifest block', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base.',
    prefs: {},
    memories: [],
    projectManifest: { files: [], chats: [] },
  })
  expect(result).not.toContain('Project context you can consult:')
})

test('projectManifest chats include summary first sentence only', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [],
    projectManifest: {
      files: [],
      chats: [{ chatId: 'chat-1', title: 'Planning', summary: 'We planned the launch. Then we celebrated.' }],
    },
  })
  expect(result).toContain('We planned the launch')
  expect(result).not.toContain('Then we celebrated')
})

test('projectManifest chat without summary → no dash suffix', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [],
    projectManifest: {
      files: [],
      chats: [{ chatId: 'chat-1', title: 'Planning' }],
    },
  })
  expect(result).toContain('[chat-1] Planning')
  // No trailing ' — ' with empty content
  const line = result.split('\n').find(l => l.includes('[chat-1]'))!
  expect(line.trim()).toBe('- [chat-1] Planning')
})

// ── forcedFiles ───────────────────────────────────────────────────────────────

test('forcedFiles present → "Always-included project files" block present with file content', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [],
    forcedFiles: [
      { name: 'config.json', content: '{"key": "value"}' },
    ],
  })
  expect(result).toContain('Always-included project files (full content):')
  expect(result).toContain('--- config.json ---')
  expect(result).toContain('{"key": "value"}')
})

test('forcedFiles with multiple files → all files rendered', () => {
  const result = assembleSystemPrompt({
    basePrompt: '',
    prefs: {},
    memories: [],
    forcedFiles: [
      { name: 'file-a.txt', content: 'Content A' },
      { name: 'file-b.txt', content: 'Content B' },
    ],
  })
  expect(result).toContain('--- file-a.txt ---')
  expect(result).toContain('Content A')
  expect(result).toContain('--- file-b.txt ---')
  expect(result).toContain('Content B')
})

test('empty forcedFiles array → no forced files block', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base.',
    prefs: {},
    memories: [],
    forcedFiles: [],
  })
  expect(result).not.toContain('Always-included project files')
})

test('forcedFiles absent → no forced files block', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base.',
    prefs: {},
    memories: [],
  })
  expect(result).not.toContain('Always-included project files')
})

// ── ordering: manifest and forced files appear after project memory ────────────

test('order: projectMemory → manifest → forcedFiles', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Base.',
    prefs: {},
    memories: [],
    projectMemories: [{ memId: 'pm-1', text: 'Project is Chatrock', category: 'identity' }],
    projectManifest: {
      files: [{ fileId: 'file-1', name: 'README.md', inclusion: 'manual' }],
      chats: [],
    },
    forcedFiles: [{ name: 'spec.md', content: 'Spec content here' }],
  })

  const projMemIdx = result.indexOf('What you know about this project:')
  const manifestIdx = result.indexOf('Project context you can consult:')
  const forcedIdx = result.indexOf('Always-included project files')

  expect(projMemIdx).toBeGreaterThanOrEqual(0)
  expect(manifestIdx).toBeGreaterThanOrEqual(0)
  expect(forcedIdx).toBeGreaterThanOrEqual(0)

  expect(projMemIdx).toBeLessThan(manifestIdx)
  expect(manifestIdx).toBeLessThan(forcedIdx)
})

test('order: effectiveInstructions → projectInstructions → date → answerLength → userMemory → projectMemory', () => {
  const result = assembleSystemPrompt({
    basePrompt: 'Chat instructions.',
    prefs: {
      injectCurrentDate: true,
      answerLength: 'short',
    },
    memories: [{ memId: 'um-1', text: 'User likes brevity', category: 'style' }],
    now: '2026-06-16T10:00:00.000Z',
    memoryToolEnabled: true,
    projectInstructions: 'Project-level rules.',
    projectMemories: [{ memId: 'pm-1', text: 'Project is Chatrock', category: 'identity' }],
    projectMemoryToolEnabled: true,
  })

  const chatIdx = result.indexOf('Chat instructions.')
  const projInstIdx = result.indexOf('Project instructions:')
  const dateIdx = result.indexOf("Today's date is 2026-06-16.")
  const lengthIdx = result.indexOf('concise')
  const userMemIdx = result.indexOf('What you know about the user:')
  const projMemIdx = result.indexOf('What you know about this project:')

  expect(chatIdx).toBeGreaterThanOrEqual(0)
  expect(projInstIdx).toBeGreaterThanOrEqual(0)
  expect(dateIdx).toBeGreaterThanOrEqual(0)
  expect(lengthIdx).toBeGreaterThanOrEqual(0)
  expect(userMemIdx).toBeGreaterThanOrEqual(0)
  expect(projMemIdx).toBeGreaterThanOrEqual(0)

  expect(chatIdx).toBeLessThan(projInstIdx)
  expect(projInstIdx).toBeLessThan(dateIdx)
  expect(dateIdx).toBeLessThan(lengthIdx)
  expect(lengthIdx).toBeLessThan(userMemIdx)
  expect(userMemIdx).toBeLessThan(projMemIdx)
})
