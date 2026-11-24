import { describe, expect, it } from 'vitest'
import {
  calculateShannonEntropy,
  scanDiffForSecretLeaks,
  scanTextForSecretLeaks,
} from './secretLeakScanner'

describe('Static Secret & Leak Scanner for Git Commits & Patch Queues (EVIDENCE-004)', () => {
  it('detects embedded OpenAI and Anthropic API keys', () => {
    const text = `
      const config = {
        openaiKey: 'sk-proj-abcdef1234567890abcdef1234567890',
        anthropicKey: 'sk-ant-api03-abcdef1234567890abcdef1234',
      }
    `
    const result = scanTextForSecretLeaks(text, 'src/api.ts')
    expect(result.valid).toBe(false)
    expect(result.hasLeaks).toBe(true)
    expect(result.violations.length).toBeGreaterThanOrEqual(2)
    expect(result.violations.some((v) => v.rule === 'OpenAI API Key')).toBe(true)
    expect(result.violations.some((v) => v.rule === 'AI Model Service Key (sk-ant)')).toBe(true)

    // Ensure secrets are redacted in output
    for (const v of result.violations) {
      expect(v.redactedMatch).toContain('****')
      expect(v.redactedMatch.length).toBeLessThan(15)
    }
  })

  it('detects private cryptographic keys and database credentials', () => {
    const text = `
      -----BEGIN RSA PRIVATE KEY-----
      MIIEowIBAAKCAQEA0Y...
      -----END RSA PRIVATE KEY-----
      const dbUrl = "postgres://admin:SuperSecretPass123!@db.internal:5432/production"
    `
    const result = scanTextForSecretLeaks(text)
    expect(result.valid).toBe(false)
    expect(result.violations.some((v) => v.rule === 'Private Cryptographic Key')).toBe(true)
    expect(result.violations.some((v) => v.rule === 'Database URI with Credentials')).toBe(true)
  })

  it('calculates Shannon entropy and detects high-entropy tokens', () => {
    // Low entropy
    const low = calculateShannonEntropy('aaaaaaaaaaaaaaaaaaaa')
    expect(low).toBe(0)

    // High entropy random base64 string
    const high = calculateShannonEntropy('4kP9zL1xVq8mJ3wR6yT2bN7cF5aH0dGq')
    expect(high).toBeGreaterThan(4.5)
  })

  it('scans added lines in unified git diffs while ignoring deleted lines', () => {
    const diff = `
diff --git a/config.ts b/config.ts
--- a/config.ts
+++ b/config.ts
@@ -1,3 +1,3 @@
-const oldKey = "sk-proj-oldkey1234567890abcdef1234";
+const safeVar = process.env.API_KEY;
+const leakedAws = "AKIAIOSFODNN7EXAMPLE";
    `
    const result = scanDiffForSecretLeaks(diff)
    expect(result.valid).toBe(false)
    expect(result.violations.length).toBe(1)
    expect(result.violations[0]?.rule).toBe('AWS Access Key ID')
    expect(result.violations[0]?.filePath).toBe('config.ts')
  })

  it('passes cleanly on benign code without secrets', () => {
    const text = `
      export function add(a: number, b: number): number {
        return a + b;
      }
    `
    const result = scanTextForSecretLeaks(text)
    expect(result.valid).toBe(true)
    expect(result.hasLeaks).toBe(false)
    expect(result.violations).toHaveLength(0)
    expect(result.formattedSummary).toContain('SECRET LEAK AUDIT: PASSED')
  })
})
