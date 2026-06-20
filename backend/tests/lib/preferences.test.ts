import { resolvePreferences } from '../../src/lib/preferences'
import type { UserPreferences } from '../../src/lib/preferences'

// ── resolvePreferences ────────────────────────────────────────────────────────

test('user-only: result equals user prefs', () => {
  const user: UserPreferences = { persona: 'Be brief', answerLength: 'short', webSearchEnabled: true }
  const result = resolvePreferences({ user })
  expect(result).toEqual(user)
})

test('chat overrides user: chat value wins', () => {
  const user: UserPreferences = { answerLength: 'default', webSearchEnabled: false }
  const chat: UserPreferences = { answerLength: 'extensive' }
  const result = resolvePreferences({ user, chat })
  expect(result.answerLength).toBe('extensive')
  expect(result.webSearchEnabled).toBe(false) // user value preserved where chat doesn't override
})

test('project overrides user but chat overrides project', () => {
  const user: UserPreferences = { answerLength: 'default', temperature: 0.5, webSearchEnabled: false }
  const project: UserPreferences = { answerLength: 'short', temperature: 0.7 }
  const chat: UserPreferences = { answerLength: 'extensive' }
  const result = resolvePreferences({ user, project, chat })
  expect(result.answerLength).toBe('extensive') // chat wins
  expect(result.temperature).toBe(0.7)           // project overrides user
  expect(result.webSearchEnabled).toBe(false)            // user preserved
})

test('undefined values at a layer do not override lower layers', () => {
  const user: UserPreferences = { persona: 'helpful', answerLength: 'short' }
  const chat: UserPreferences = { persona: undefined, answerLength: 'extensive' }
  const result = resolvePreferences({ user, chat })
  // undefined in chat should NOT override user's defined persona
  expect(result.persona).toBe('helpful')
  expect(result.answerLength).toBe('extensive')
})

test('absent layers (project=undefined, chat=undefined): just user result', () => {
  const user: UserPreferences = { injectCurrentDate: true, defaultModel: 'claude-3' }
  const result = resolvePreferences({ user, project: undefined, chat: undefined })
  expect(result).toEqual(user)
})

test('empty input: returns {}', () => {
  const result = resolvePreferences({})
  expect(result).toEqual({})
})

test('all layers absent: returns {}', () => {
  const result = resolvePreferences({ user: undefined, project: undefined, chat: undefined })
  expect(result).toEqual({})
})

test('chat-only without user: returns chat prefs', () => {
  const chat: UserPreferences = { webSearchEnabled: true, thinkingEffort: 'high' }
  const result = resolvePreferences({ chat })
  expect(result).toEqual(chat)
})

test('resolution order is user < project < chat for each key independently', () => {
  const user: UserPreferences = { persona: 'user-persona', answerLength: 'default', topP: 0.9 }
  const project: UserPreferences = { persona: 'project-persona', answerLength: 'short' }
  const chat: UserPreferences = { persona: 'chat-persona' }
  const result = resolvePreferences({ user, project, chat })
  expect(result.persona).toBe('chat-persona')      // chat wins
  expect(result.answerLength).toBe('short')         // project wins over user
  expect(result.topP).toBe(0.9)                    // user value, nothing overrides
})
