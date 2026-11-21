import type { ErrorContext } from 'react-oidc-context'

const DEFAULT_RETURN_PATH = '/c/new'

export function isNetworkAuthError(error: ErrorContext | undefined): boolean {
  return /NetworkError|Failed to fetch|network/i.test(error?.message ?? '')
}

// A silent refresh that fails for any reason but the network means Cognito rejected the
// refresh token (`invalid_grant`: past its validity window, or revoked) and only an
// interactive sign-in can recover. A failed sign-in callback is excluded: redirecting
// from it could bounce between the app and the Hosted UI forever.
export function needsInteractiveSignin(error: ErrorContext | undefined): boolean {
  if (!error || isNetworkAuthError(error)) return false
  return error.source === 'signinSilent' || error.source === 'renewSilent'
}

// Carried through the OIDC round trip as `signinRedirect({ state })`, so a sign-in lands
// back on the page that needed it rather than a new chat.
export function returnToState(loc: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location) {
  return { returnTo: loc.pathname.startsWith('/callback') ? DEFAULT_RETURN_PATH : loc.pathname + loc.search + loc.hash }
}

export function returnPathFromState(state: unknown): string {
  const returnTo = (state as { returnTo?: unknown } | undefined)?.returnTo
  return typeof returnTo === 'string' && returnTo.startsWith('/') ? returnTo : DEFAULT_RETURN_PATH
}
