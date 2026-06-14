import type { UserPreferences } from './preferences'

export interface AssembleInput {
  basePrompt: string          // the chat's systemPrompt (client-supplied)
  prefs: UserPreferences
  memories: Array<{ text: string; category: string }>
  now?: string                // ISO date string — injected if injectCurrentDate=true
}

export function assembleSystemPrompt(input: AssembleInput): string {
  const parts: string[] = []

  // 1. Persona / custom instructions
  if (input.prefs.persona?.trim()) {
    parts.push(input.prefs.persona.trim())
  }

  // 2. Current date injection
  if (input.prefs.injectCurrentDate && input.now) {
    const dateStr = input.now.slice(0, 10)  // YYYY-MM-DD
    parts.push(`Today's date is ${dateStr}.`)
  }

  // 3. Answer-length directive
  if (input.prefs.answerLength === 'short') {
    parts.push('Keep your answers concise and to the point.')
  } else if (input.prefs.answerLength === 'extensive') {
    parts.push('Provide thorough, detailed answers.')
  }

  // 4. User memory block
  if (input.memories.length > 0) {
    const memLines = input.memories.map(m => `- ${m.text}`).join('\n')
    parts.push(`What you know about the user:\n${memLines}`)
  }

  // 5. Base prompt (chat's own system prompt)
  if (input.basePrompt.trim()) {
    parts.push(input.basePrompt.trim())
  }

  return parts.join('\n\n')
}
