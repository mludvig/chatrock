export function subFromClaims(claims: unknown): string {
  if (claims && typeof claims === 'object' && 'sub' in claims) {
    const sub = (claims as Record<string, unknown>).sub
    if (typeof sub === 'string' && sub.length > 0) return sub
  }
  throw new Error('Missing sub claim')
}
