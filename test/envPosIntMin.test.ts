import { afterEach, describe, expect, it } from 'vitest'
import { posIntMin } from '../src/config/env.js'

// Boundary coverage for the SEARCH_INDEX_QUEUE_MAX clamp. A bogus value must
// never reach Redis LTRIM as 0 (which retains the whole list, defeating the cap
// and reintroducing unbounded shared-Redis growth), nor as a fraction/Infinity
// (which throws a Redis command error at push time).
describe('posIntMin (SEARCH_INDEX_QUEUE_MAX clamp)', () => {
  const NAME = 'TEST_POS_INT_MIN'
  afterEach(() => {
    delete process.env[NAME]
  })

  it('returns the fallback when the env var is unset', () => {
    expect(posIntMin(NAME, 100_000, 1)).toBe(100_000)
  })

  it('clamps 0 up to the minimum (would otherwise LTRIM 0 -1 = keep all)', () => {
    process.env[NAME] = '0'
    expect(posIntMin(NAME, 100_000, 1)).toBe(1)
  })

  it('clamps negatives up to the minimum', () => {
    process.env[NAME] = '-5'
    expect(posIntMin(NAME, 100_000, 1)).toBe(1)
  })

  it('floors fractional values to an integer', () => {
    process.env[NAME] = '10.9'
    expect(posIntMin(NAME, 100_000, 1)).toBe(10)
  })

  it('floors a fractional value that would land below min up to min', () => {
    process.env[NAME] = '0.5'
    expect(posIntMin(NAME, 100_000, 1)).toBe(1)
  })

  it('falls back on non-finite Infinity rather than passing it to Redis', () => {
    process.env[NAME] = 'Infinity'
    expect(posIntMin(NAME, 100_000, 1)).toBe(100_000)
  })

  it('accepts a valid positive integer unchanged', () => {
    process.env[NAME] = '250'
    expect(posIntMin(NAME, 100_000, 1)).toBe(250)
  })

  it('throws on a non-numeric value (num() guard, surfaces misconfig loudly)', () => {
    process.env[NAME] = 'abc'
    expect(() => posIntMin(NAME, 100_000, 1)).toThrow()
  })
})
