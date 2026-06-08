import { subFromClaims } from '../../src/lib/auth'

test('extracts sub from valid claims', () => {
  expect(subFromClaims({ sub: 'user-123' })).toBe('user-123')
})

test('throws when sub missing', () => {
  expect(() => subFromClaims({})).toThrow('Missing sub claim')
})

test('throws when claims null', () => {
  expect(() => subFromClaims(null)).toThrow('Missing sub claim')
})

test('throws when sub is empty string', () => {
  expect(() => subFromClaims({ sub: '' })).toThrow('Missing sub claim')
})
