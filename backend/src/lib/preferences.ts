export interface UserPreferences {
  persona?: string                    // free-text custom instructions
  injectCurrentDate?: boolean         // prepend current date to prompt
  answerLength?: 'default' | 'short' | 'extensive'
  defaultModel?: string
  thinkingEffort?: 'off' | 'low' | 'medium' | 'high' | 'max'
  webSearch?: boolean
  temperature?: number
  topP?: number
  topK?: number
  showTokenStats?: boolean            // UI flag (not prompt-affecting)
}

export interface ResolveInput {
  user?: UserPreferences
  project?: UserPreferences           // not used yet, bakes in for Phase 2
  chat?: UserPreferences              // not used yet, bakes in for Phase 2
}

// Resolution order: chat overrides project overrides user (per-key, shallow)
export function resolvePreferences(input: ResolveInput): UserPreferences {
  const result: UserPreferences = {}
  const layers = [input.user, input.project, input.chat].filter(Boolean) as UserPreferences[]
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined) (result as Record<string, unknown>)[k] = v
    }
  }
  return result
}
