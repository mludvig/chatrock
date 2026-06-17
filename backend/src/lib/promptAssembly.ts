import type { UserPreferences } from './preferences'

export interface AssembleInput {
  basePrompt: string          // the chat's systemPrompt (client-supplied)
  prefs: UserPreferences
  memories: Array<{ memId?: string; text: string; category: string }>
  now?: string                // ISO date string — chat.createdAt; always injected when present
  memoryToolEnabled?: boolean // if true, include manage_memory capability instructions
  // New fields for project chats:
  projectInstructions?: string      // injected after effective custom instructions
  projectMemories?: Array<{ memId?: string; text: string; category: string }>
  projectMemoryToolEnabled?: boolean
  // Manifest of project files and sibling chats ('never' items already filtered out by caller)
  projectManifest?: {
    files: Array<{ fileId: string; name: string; microLabel?: string; inclusion: string }>
    chats: Array<{ chatId: string; title: string; summary?: string }>
  }
  // Files to force-include in full (inclusion:'always' — caller provides content already capped)
  forcedFiles?: Array<{ name: string; content: string }>
  // Whether the read_project_file/read_project_chat tools are available
  projectReadToolsEnabled?: boolean
}

export function assembleSystemPrompt(input: AssembleInput): string {
  const parts: string[] = []

  // 1. Effective custom instructions — per-chat basePrompt takes priority;
  //    falls back to global persona when basePrompt is empty/absent.
  const effectiveInstructions = input.basePrompt.trim() || input.prefs.persona?.trim() || ''
  if (effectiveInstructions) {
    parts.push(effectiveInstructions)
  }

  // 1b. Project instructions — injected after effective custom instructions
  if (input.projectInstructions?.trim()) {
    parts.push(`Project instructions:\n${input.projectInstructions.trim()}`)
  }

  // 2. Chat creation date — always injected (stable value, no caching impact)
  if (input.now) {
    const dateStr = new Date(input.now).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
    const tsNote = input.prefs.injectCurrentDate
      ? " Individual messages include a 'Current timestamp' line reflecting when they were sent."
      : ''
    parts.push(`Chat created: ${dateStr}.${tsNote}`)
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

  // 5. Project memory block
  if ((input.projectMemories && input.projectMemories.length > 0) || input.projectMemoryToolEnabled) {
    const lines = (input.projectMemories ?? []).map(m =>
      m.memId ? `- [${m.memId}] ${m.text}` : `- ${m.text}`
    ).join('\n')
    const header = (input.projectMemories?.length ?? 0) > 0
      ? `What you know about this project:\n${lines}`
      : `You have a persistent project memory. It is currently empty.`
    const capability = input.projectMemoryToolEnabled
      ? `\n\nYou can manage this project memory with the manage_project_memory tool: save new durable project facts (remember), correct an existing fact (update, requires memId), or remove one (forget, requires memId). Project memory is shared across all chats in this project.`
      : ''
    parts.push(header + capability)
  }

  // 6. Project manifest
  const manifest = input.projectManifest
  if (manifest && (manifest.files.length > 0 || manifest.chats.length > 0)) {
    const manifestParts: string[] = ['Project context you can consult:']
    if (manifest.files.length > 0) {
      const fileLines = manifest.files.map(f => {
        const label = f.microLabel ? ` — ${f.microLabel}` : ''
        return `- [${f.fileId}] ${f.name}${label}`
      }).join('\n')
      manifestParts.push(`Files (you currently see labels only — content is NOT loaded):\n${fileLines}`)
    }
    if (manifest.chats.length > 0) {
      const chatLines = manifest.chats.map(c => {
        const summary = c.summary ? ` — ${c.summary.split('.')[0]}` : ''
        return `- [${c.chatId}] ${c.title}${summary}`
      }).join('\n')
      manifestParts.push(`Other chats in this project (you currently see labels only):\n${chatLines}`)
    }
    const warning = 'IMPORTANT: these labels are NAVIGATIONAL ONLY. Never draw conclusions or answer from a label or summary — use them only to decide whether to read the full file/chat.'
    const toolSentence = input.projectReadToolsEnabled
      ? ' Use read_project_file / read_project_chat (detail:\'summary\' then \'full\' if needed).'
      : ''
    manifestParts.push(warning + toolSentence)
    parts.push(manifestParts.join('\n'))
  }

  // 7. Forced files (always-included content)
  if (input.forcedFiles && input.forcedFiles.length > 0) {
    const fileBlocks = input.forcedFiles.map(f => `--- ${f.name} ---\n${f.content}`).join('\n\n')
    parts.push(`Always-included project files (full content):\n\n${fileBlocks}`)
  }

  return parts.join('\n\n')
}
