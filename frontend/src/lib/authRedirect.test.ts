import { describe, expect, it } from 'vitest'
import type { ErrorContext } from 'react-oidc-context'
import { isNetworkAuthError, needsInteractiveSignin, returnPathFromState, returnToState } from './authRedirect'

const authError = (source: string, message: string) =>
  Object.assign(new Error(message), { source, args: undefined }) as ErrorContext

describe('needsInteractiveSignin', () => {
  it('is true when a silent refresh is rejected (refresh token expired or revoked)', () => {
    expect(needsInteractiveSignin(authError('signinSilent', 'invalid_grant'))).toBe(true)
    expect(needsInteractiveSignin(authError('renewSilent', 'invalid_grant'))).toBe(true)
  })

  it('is false for a network failure, which the retry loop handles', () => {
    expect(needsInteractiveSignin(authError('signinSilent', 'Failed to fetch'))).toBe(false)
    expect(isNetworkAuthError(authError('signinSilent', 'NetworkError when attempting to fetch resource.'))).toBe(true)
  })

  it('is false when the sign-in callback itself failed, so it cannot loop', () => {
    expect(needsInteractiveSignin(authError('signinCallback', 'invalid_grant'))).toBe(false)
  })

  it('is false with no error', () => {
    expect(needsInteractiveSignin(undefined)).toBe(false)
  })
})

describe('return path', () => {
  it('round-trips the current path, query and hash', () => {
    const state = returnToState({ pathname: '/c/abc', search: '?x=1', hash: '#m' })
    expect(returnPathFromState(state)).toBe('/c/abc?x=1#m')
  })

  it('does not return to the OAuth callback URL', () => {
    expect(returnPathFromState(returnToState({ pathname: '/callback', search: '?code=1', hash: '' }))).toBe('/c/new')
  })

  it('falls back to a new chat when the state is missing or malformed', () => {
    expect(returnPathFromState(undefined)).toBe('/c/new')
    expect(returnPathFromState({ returnTo: 42 })).toBe('/c/new')
    expect(returnPathFromState({ returnTo: 'https://example.com/' })).toBe('/c/new')
  })
})
