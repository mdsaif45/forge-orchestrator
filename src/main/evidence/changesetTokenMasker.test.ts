import { describe, expect, it } from 'vitest'
import { maskChangesetTokens } from './changesetTokenMasker'

describe('maskChangesetTokens', () => {
  it('masks credentials and API keys cleanly with deterministic placeholders', () => {
    const rawDiff = `
diff --git a/src/config.ts b/src/config.ts
+const API_KEY = "sk-1234567890abcdef1234567890abcdef";
+const SECOND_KEY = "sk-1234567890abcdef1234567890abcdef";
`
    const result = maskChangesetTokens(rawDiff)
    expect(result.maskedDiff).not.toContain('sk-1234567890abcdef1234567890abcdef')
    expect(result.maskedDiff).toContain('[REDACTED_CREDENTIAL_1]')
    expect(result.report.totalReplacements).toBe(2)
    expect(result.report.uniqueTokensCount).toBe(1)
  })

  it('masks internal hostnames and private IP addresses', () => {
    const rawDiff = `
+const DB_HOST = "db-primary.corp.internal";
+const FALLBACK_IP = "10.0.1.45";
`
    const result = maskChangesetTokens(rawDiff)
    expect(result.maskedDiff).not.toContain('db-primary.corp.internal')
    expect(result.maskedDiff).not.toContain('10.0.1.45')
    expect(result.maskedDiff).toContain('[REDACTED_HOST_1]')
    expect(result.maskedDiff).toContain('[REDACTED_PRIVATE_IP_1]')
    expect(result.report.uniqueTokensCount).toBe(2)
  })

  it('masks customer and tenant IDs in diff code', () => {
    const rawDiff = `
+const primaryTenant = "cust_9988776655aabbcc";
+const partnerTenant = "tenant_1122334455667788";
`
    const result = maskChangesetTokens(rawDiff)
    expect(result.maskedDiff).not.toContain('cust_9988776655aabbcc')
    expect(result.maskedDiff).not.toContain('tenant_1122334455667788')
    expect(result.report.uniqueTokensCount).toBe(2)
    expect(result.report.tokens.every((t) => t.category === 'CUSTOMER_ID')).toBe(true)
  })

  it('supports custom regex patterns and prefixes', () => {
    const rawDiff = `+const projectCode = "PRJ-98745-ALPHA";`
    const result = maskChangesetTokens(rawDiff, {
      customPatterns: [{ pattern: /PRJ-\d{5}-[A-Z]+/g, maskPrefix: 'PROJECT_CODE' }],
    })
    expect(result.maskedDiff).toContain('[REDACTED_PROJECT_CODE_1]')
    expect(result.report.uniqueTokensCount).toBe(1)
    expect(result.report.tokens[0]?.category).toBe('CUSTOM')
  })

  it('handles empty diff text and clean diffs with zero replacements', () => {
    const emptyResult = maskChangesetTokens('')
    expect(emptyResult.maskedDiff).toBe('')
    expect(emptyResult.report.totalReplacements).toBe(0)

    const cleanDiff = `+const x = 42;\n+export function add(a, b) { return a + b; }`
    const cleanResult = maskChangesetTokens(cleanDiff)
    expect(cleanResult.maskedDiff).toBe(cleanDiff)
    expect(cleanResult.report.totalReplacements).toBe(0)
    expect(cleanResult.report.uniqueTokensCount).toBe(0)
  })
})
