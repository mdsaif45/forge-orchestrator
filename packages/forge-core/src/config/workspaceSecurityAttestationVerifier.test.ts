import { describe, it, expect } from 'vitest'
import {
  WorkspaceSecurityAttestationVerifier,
  type SecretVerificationRule,
} from './workspaceSecurityAttestationVerifier'

describe('WorkspaceSecurityAttestationVerifier (CONFIG-025)', () => {
  const verifier = new WorkspaceSecurityAttestationVerifier()

  it('grants security attestation and produces token when all rules are satisfied', () => {
    const env = {
      OPENAI_KEY: 'sk-proj-abc123xyz890randomsecretstring456',
      GITHUB_TOKEN: 'ghp_secrettokenwithhighrandomness12345',
    }

    const rules: SecretVerificationRule[] = [
      { key: 'OPENAI_KEY', expectedPrefix: 'sk-', minEntropy: 3.0, minLength: 20 },
      { key: 'GITHUB_TOKEN', expectedPrefix: 'ghp_', minEntropy: 3.0, minLength: 15 },
    ]

    const report = verifier.verifyAndAttest(env, rules, 'prod-agent-policy')

    expect(report.isAttested).toBe(true)
    expect(report.attestationToken).toHaveLength(64)
    expect(report.verifiedKeys).toEqual(['GITHUB_TOKEN', 'OPENAI_KEY'])
    expect(report.missingKeys).toHaveLength(0)
    expect(report.invalidKeys).toHaveLength(0)
    expect(report.summary).toContain('Security attestation granted')
  })

  it('denies attestation when a mandatory secret is missing', () => {
    const env = {
      OPENAI_KEY: 'sk-proj-abc123xyz890randomsecretstring456',
    }

    const rules: SecretVerificationRule[] = [
      { key: 'OPENAI_KEY', expectedPrefix: 'sk-' },
      { key: 'GITHUB_TOKEN', expectedPrefix: 'ghp_' },
    ]

    const report = verifier.verifyAndAttest(env, rules)
    expect(report.isAttested).toBe(false)
    expect(report.attestationToken).toBeNull()
    expect(report.missingKeys).toContain('GITHUB_TOKEN')
  })

  it('denies attestation when secret prefix fails contract', () => {
    const env = {
      API_KEY: 'invalid_prefix_1234567890abcdef',
    }

    const rules: SecretVerificationRule[] = [{ key: 'API_KEY', expectedPrefix: 'sk-' }]

    const report = verifier.verifyAndAttest(env, rules)
    expect(report.isAttested).toBe(false)
    expect(report.invalidKeys).toHaveLength(1)
    expect(report.invalidKeys[0]?.reason).toContain("does not match required security prefix 'sk-'")
  })

  it('denies attestation when secret has repetitive low entropy', () => {
    const env = {
      LOW_ENTROPY_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }

    const rules: SecretVerificationRule[] = [
      { key: 'LOW_ENTROPY_KEY', minEntropy: 2.5, minLength: 10 },
    ]

    const report = verifier.verifyAndAttest(env, rules)
    expect(report.isAttested).toBe(false)
    expect(report.invalidKeys[0]?.reason).toContain('below required randomness floor')
  })

  it('permits missing optional secrets without failing attestation', () => {
    const env = {
      MAIN_KEY: 'sk-mainsecretwithhighrandomness987654321',
    }

    const rules: SecretVerificationRule[] = [
      { key: 'MAIN_KEY', expectedPrefix: 'sk-' },
      { key: 'OPTIONAL_KEY', expectedPrefix: 'opt-', optional: true },
    ]

    const report = verifier.verifyAndAttest(env, rules)
    expect(report.isAttested).toBe(true)
    expect(report.verifiedKeys).toEqual(['MAIN_KEY'])
    expect(report.missingKeys).toHaveLength(0)
  })
})
