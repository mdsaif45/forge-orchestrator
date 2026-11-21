import { describe, it, expect } from 'vitest'
import { redactSensitiveString, redactEnvironmentVariables } from './sensitiveDataRedactor'

describe('SensitiveDataRedactor (CONFIG-015)', () => {
  it('redacts API keys and personal access tokens while leaving public text intact', () => {
    const raw =
      'Config: sk-proj-1234567890abcdef1234567890, and ghp_1234567890abcdef1234567890abcdef1234'
    const audit = redactSensitiveString(raw)

    expect(audit.totalRedactions).toBe(2)
    expect(audit.sanitizedText).toContain('[REDACTED_API_KEY]')
    expect(audit.sanitizedText).toContain('[REDACTED_GITHUB_TOKEN]')
    expect(audit.sanitizedText).not.toContain('1234567890abcdef')
    expect(audit.matchesByRule.standard_api_key).toBe(1)
    expect(audit.matchesByRule.github_personal_token).toBe(1)
  })

  it('redacts Bearer tokens and JWTs in HTTP headers', () => {
    const raw =
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.signature1234567890'
    const audit = redactSensitiveString(raw)

    expect(audit.totalRedactions).toBeGreaterThan(0)
    expect(audit.sanitizedText).toContain('[REDACTED_BEARER_TOKEN]')
  })

  it('redacts private key blocks', () => {
    const raw = `
Some intro text
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y1+example+private+key+payload+that+must+never+leak
-----END RSA PRIVATE KEY-----
Some trailing text
`
    const audit = redactSensitiveString(raw)
    expect(audit.totalRedactions).toBe(1)
    expect(audit.sanitizedText).toContain('[REDACTED_PRIVATE_KEY_BLOCK]')
    expect(audit.sanitizedText).not.toContain('example+private+key')
  })

  it('redacts database passwords in connection URLs', () => {
    const raw = 'postgres://postgres:super_secret_db_pass@localhost:5432/forge_db'
    const audit = redactSensitiveString(raw)

    expect(audit.totalRedactions).toBe(1)
    expect(audit.sanitizedText).toContain(
      'postgres://postgres:[REDACTED_PASSWORD]@localhost:5432/forge_db',
    )
    expect(audit.sanitizedText).not.toContain('super_secret_db_pass')
  })

  it('obfuscates environment variable maps based on sensitive key heuristics', () => {
    const env = {
      APP_PORT: '3000',
      DATABASE_PASSWORD: 'mypassword123',
      FORGE_API_KEY: 'sk-proj-999999999999999999999999',
      SAFE_FLAG: 'true',
    }

    const redacted = redactEnvironmentVariables(env)
    expect(redacted.APP_PORT).toBe('3000')
    expect(redacted.SAFE_FLAG).toBe('true')
    expect(redacted.DATABASE_PASSWORD).toBe('***[REDACTED]***')
    expect(redacted.FORGE_API_KEY).toBe('***[REDACTED]***')
  })

  it('honors allowedKeys override to retain specific whitelisted variables', () => {
    const env = {
      FORGE_PUBLIC_KEY: 'pk_live_12345',
      INTERNAL_TOKEN: 'secret_value',
    }

    const redacted = redactEnvironmentVariables(env, {
      allowedKeys: ['FORGE_PUBLIC_KEY'],
    })

    expect(redacted.FORGE_PUBLIC_KEY).toBe('pk_live_12345')
    expect(redacted.INTERNAL_TOKEN).toBe('***[REDACTED]***')
  })
})
