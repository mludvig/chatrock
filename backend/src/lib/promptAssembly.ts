import type { UserPreferences } from './preferences'

export interface AssembleInput {
  basePrompt: string          // the chat's systemPrompt (client-supplied)
  prefs: UserPreferences
  memories: Array<{ memId?: string; text: string; category: string }>
  now?: string                // ISO date string — injected if injectCurrentDate=true
  memoryToolEnabled?: boolean // if true, include manage_memory capability instructions
}

export function assembleSystemPrompt(input: AssembleInput): string {
  const parts: string[] = []

  // 1. Effective custom instructions — per-chat replaces global default when non-empty
  const effectiveInstructions = input.basePrompt.trim() || input.prefs.persona?.trim() || ''
  if (effectiveInstructions) {
    parts.push(effectiveInstructions)
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
  if (input.memories.length > 0 || input.memoryToolEnabled) {
    const lines = input.memories.map(m =>
      m.memId ? `- [${m.memId}] ${m.text}` : `- ${m.text}`
    ).join('\n')
    const header = input.memories.length > 0
      ? `What you know about the user:\n${lines}`
      : `You have a persistent memory about the user. It is currently empty.`
    const capability = input.memoryToolEnabled
      ? `\n\nYou can manage this memory with the manage_memory tool: save new durable facts (remember), correct an existing fact (update, requires memId), or remove one (forget, requires memId). Memory persists across all future conversations.`
      : ''
    parts.push(header + capability)
  }

  return parts.join('\n\n')
}
