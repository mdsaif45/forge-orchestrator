import { describe, expect, it } from 'vitest'
import { cn } from './cn'

describe('cn (@forge/ui)', () => {
  it('merges conditional classes and lets later Tailwind utilities win', () => {
    expect(cn('px-3 py-1 text-sm', { 'px-6': true, hidden: false })).toBe('py-1 text-sm px-6')
  })
})
