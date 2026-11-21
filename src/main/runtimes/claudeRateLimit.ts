/**
 * Claude rate-limit and overage signal detection (#147, #180).
 *
 * Axiom A2: Detected strictly from structured provider signals (stream-json,
 * notification hooks, or hook payloads), never scraped from screen prose.
 */

export interface ClaudeRateLimitInfo {
  readonly status?: string | null
  readonly rateLimitType?: string | null
  readonly overageStatus?: string | null
  readonly isUsingOverage?: boolean | null
  readonly overageInUse?: boolean | null
  [key: string]: unknown
}

/**
 * Evaluates whether a Claude account's limit is actually spent.
 *
 * CRITICAL RULE (Issue #147, #180):
 * `status` alone is NOT a spent limit. Measured on a turn that completed normally:
 *
 *   {"status":"rejected","rateLimitType":"five_hour",
 *    "overageStatus":"allowed_warning","isUsingOverage":true,"overageInUse":true}
 *
 * The primary window was exhausted and the request was served from overage — the work
 * succeeded. An earlier version treated any non-"allowed" status as spent and halted
 * a live run that was working.
 *
 * An account is ONLY spent when the overage fallback is refused too.
 * Both primary AND overage must be non-allowed before Forge marks providerLimit: true.
 */
export function isClaudeRateLimitSpent(info: ClaudeRateLimitInfo | null | undefined): boolean {
  if (!info || typeof info !== 'object') {
    return false
  }

  const status = typeof info.status === 'string' ? info.status : null
  const overageStatus = typeof info.overageStatus === 'string' ? info.overageStatus : null

  const primarySpent = status !== null && status !== 'allowed'
  const overageSpent =
    overageStatus !== null && overageStatus !== 'allowed' && !overageStatus.startsWith('allowed')

  return primarySpent && overageSpent
}

/**
 * Extracts ClaudeRateLimitInfo from an arbitrary message or hook payload if present.
 */
export function extractRateLimitInfo(payload: unknown): ClaudeRateLimitInfo | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const rec = payload as Record<string, unknown>

  if (rec.rate_limit_info && typeof rec.rate_limit_info === 'object') {
    return rec.rate_limit_info as ClaudeRateLimitInfo
  }

  if (rec.rateLimitInfo && typeof rec.rateLimitInfo === 'object') {
    return rec.rateLimitInfo as ClaudeRateLimitInfo
  }

  if (
    typeof rec.status === 'string' &&
    (rec.rateLimitType !== undefined || rec.overageStatus !== undefined)
  ) {
    return rec
  }

  return null
}
