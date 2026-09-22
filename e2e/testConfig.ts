// Shared model labels for e2e specs — keep in sync with backend/src/config/models.ts's
// MODELS array. Update here when a model is renamed/retired so specs don't have to be
// hunted down individually (see backend/CLAUDE.md's "Retired models" note —
// this has already happened once, Sonnet 4.6 -> 5).
export const THINKING_MODEL_LABEL = 'Claude Sonnet 5'  // thinking-capable, temperature/topP tunable
export const FAST_MODEL_LABEL = 'Claude Haiku 4.5'     // no thinking, cheapest/fastest
