import { describe, expect, it } from 'vitest'
import {
  extractRateLimitInfo,
  isClaudeRateLimitSpent,
  type ClaudeRateLimitInfo,
} from './claudeRateLimit'

describe('claudeRateLimit (Issue #180)', () => {
  it('identifies an allowed rate limit status as not spent', () => {
    const info: ClaudeRateLimitInfo = {
      status: 'allowed',
      rateLimitType: 'five_hour',
      overageStatus: 'allowed',
      isUsingOverage: false,
    }

    expect(isClaudeRateLimitSpent(info)).toBe(false)
  })

  it('preserves the overage rule: status "rejected" with overageStatus "allowed_warning" is NOT spent', () => {
    // Measured on a working turn from Issue #147 / #180
    const workingTurnWithOverage: ClaudeRateLimitInfo = {
      status: 'rejected',
      rateLimitType: 'five_hour',
      overageStatus: 'allowed_warning',
      isUsingOverage: true,
      overageInUse: true,
    }

    expect(isClaudeRateLimitSpent(workingTurnWithOverage)).toBe(false)
  })

  it('tolerates overageStatus starting with "allowed" as not spent', () => {
    const info: ClaudeRateLimitInfo = {
      status: 'rejected',
      rateLimitType: 'five_hour',
      overageStatus: 'allowed_info',
    }

    expect(isClaudeRateLimitSpent(info)).toBe(false)
  })

  it('marks limit as spent ONLY when both primary quota and overage are refused', () => {
    const spentInfo: ClaudeRateLimitInfo = {
      status: 'rejected',
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      isUsingOverage: false,
    }

    expect(isClaudeRateLimitSpent(spentInfo)).toBe(true)
  })

  it('returns false for missing or null info', () => {
    expect(isClaudeRateLimitSpent(null)).toBe(false)
    expect(isClaudeRateLimitSpent(undefined)).toBe(false)
  })

  it('extracts rate limit info from nested payloads', () => {
    const hookPayload = {
      session_id: 'session-123',
      rate_limit_info: {
        status: 'rejected',
        rateLimitType: 'five_hour',
        overageStatus: 'allowed_warning',
      },
    }

    const extracted = extractRateLimitInfo(hookPayload)
    expect(extracted).not.toBeNull()
    expect(extracted?.status).toBe('rejected')
    expect(extracted?.overageStatus).toBe('allowed_warning')
    expect(isClaudeRateLimitSpent(extracted)).toBe(false)
  })
})
