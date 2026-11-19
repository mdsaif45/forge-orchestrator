import { describe, expect, it } from 'vitest'
import { validateCommitMessage } from './commitValidator'

describe('Commit Message Conventional Specification & Impact Validator (EVIDENCE-005)', () => {
  it('validates canonical conventional commit messages with scope', () => {
    const msg = 'feat(core): add tool idempotency cache\n\nCache read-only tools.\n\nCloses #296'
    const result = validateCommitMessage(msg)

    expect(result.valid).toBe(true)
    expect(result.type).toBe('feat')
    expect(result.scope).toBe('core')
    expect(result.subject).toBe('add tool idempotency cache')
    expect(result.isBreaking).toBe(false)
    expect(result.footers.length).toBe(1)
    expect(result.footers[0]?.token).toBe('Closes')
    expect(result.footers[0]?.value).toBe('#296')
  })

  it('detects breaking changes via ! header suffix and footers', () => {
    const msgBang = 'feat(api)!: remove v1 endpoints'
    const resBang = validateCommitMessage(msgBang)
    expect(resBang.valid).toBe(true)
    expect(resBang.isBreaking).toBe(true)

    const msgFooter =
      'fix: change response envelope\n\nBREAKING CHANGE: response is wrapped in { data }'
    const resFooter = validateCommitMessage(msgFooter)
    expect(resFooter.valid).toBe(true)
    expect(resFooter.isBreaking).toBe(true)
  })

  it('fails closed on unknown types, trailing periods, and empty messages (Axiom A2)', () => {
    expect(validateCommitMessage('').valid).toBe(false)

    const invalidType = validateCommitMessage('randomtype: do something unexpected')
    expect(invalidType.valid).toBe(false)
    expect(invalidType.errors.some((e) => e.includes('Unknown commit type'))).toBe(true)

    const trailingPeriod = validateCommitMessage('fix: fix the bug.')
    expect(trailingPeriod.valid).toBe(false)
    expect(trailingPeriod.errors.some((e) => e.includes('should not end with a period'))).toBe(true)
  })

  it('enforces header length ceiling (Axiom A5)', () => {
    const longHeader = `fix: ${'a'.repeat(110)}`
    const res = validateCommitMessage(longHeader)

    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => e.includes('exceeds maximum length of 100'))).toBe(true)
  })
})
