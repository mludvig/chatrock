import { describe, expect, it } from 'vitest'
import { carryThinkingEffort, type ModelCapabilities } from './http'

const caps = (thinkingLevels?: ModelCapabilities['thinkingLevels'], thinking: ModelCapabilities['thinking'] = 'effort'): ModelCapabilities =>
  ({ provider: 'bedrock-responses', thinking, thinkingLevels, attachments: true, documents: true, promptCaching: 'none' })

describe('carryThinkingEffort', () => {
  it('keeps the chosen effort when the new model supports it', () => {
    expect(carryThinkingEffort('medium', caps(['low', 'medium', 'high', 'max']))).toBe('medium')
  })
  it('keeps it when the new model does not restrict levels', () => {
    expect(carryThinkingEffort('high', caps(undefined))).toBe('high')
  })
  it('drops it when the new model does not offer that level', () => {
    expect(carryThinkingEffort('max', caps(['low', 'medium', 'high']))).toBeNull()
  })
  it('drops it when the new model has no thinking', () => {
    expect(carryThinkingEffort('medium', caps(undefined, 'none'))).toBeNull()
  })
  it('stays null when nothing was chosen', () => {
    expect(carryThinkingEffort(null, caps(['low', 'medium']))).toBeNull()
  })
})
