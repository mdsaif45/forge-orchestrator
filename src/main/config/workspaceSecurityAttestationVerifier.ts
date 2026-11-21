/**
 * Copyright (c) 2026 Forge Authors
 * Technology: TypeScript / Node.js
 * Architecture: Workspace Security Policy Sandbox Attestation & Zero-Knowledge Secret Verifier (CONFIG-025)
 * Axioms Enforced:
 *  - A1: Bugs are bounded & fail-closed (invalid credentials deny attestation token).
 *  - A3: Physical evidence beats claims (cryptographic attestation tokens bind verified policies).
 *  - A7: Least privilege & security (zero plaintext retention in memory or logs).
 */

import { createHash } from 'node:crypto'

export interface SecretVerificationRule {
  readonly key: string
  readonly expectedPrefix?: string | undefined
  readonly minEntropy?: number | undefined
  readonly minLength?: number | undefined
  readonly optional?: boolean | undefined
}

export interface InvalidSecretDetail {
  readonly key: string
  readonly reason: string
}

export interface AttestationReport {
  readonly isAttested: boolean
  readonly policyId: string
  readonly attestationToken: string | null
  readonly verifiedKeys: readonly string[]
  readonly missingKeys: readonly string[]
  readonly invalidKeys: readonly InvalidSecretDetail[]
  readonly totalRulesAudited: number
  readonly summary: string
}

function calculateEntropy(str: string): number {
  if (!str || str.length === 0) return 0
  const freq = new Map<string, number>()
  for (const char of str) {
    freq.set(char, (freq.get(char) ?? 0) + 1)
  }
  let entropy = 0
  for (const count of freq.values()) {
    const p = count / str.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

export class WorkspaceSecurityAttestationVerifier {
  /**
   * Verifies required credentials without storing or logging plaintext secrets.
   */
  public verifyAndAttest(
    environment: Record<string, string | undefined>,
    rules: readonly SecretVerificationRule[],
    policyId = 'default-sandbox-policy',
  ): AttestationReport {
    const verifiedKeys: string[] = []
    const missingKeys: string[] = []
    const invalidKeys: InvalidSecretDetail[] = []
    const verifiedDigests: string[] = []

    for (const rule of rules) {
      const rawVal = environment[rule.key]

      if (rawVal === undefined || rawVal.trim().length === 0) {
        if (!rule.optional) {
          missingKeys.push(rule.key)
        }
        continue
      }

      const val = rawVal.trim()
      const minLen = rule.minLength ?? 10
      const minEntropy = rule.minEntropy ?? 2.5

      if (val.length < minLen) {
        invalidKeys.push({
          key: rule.key,
          reason: `Secret length (${String(val.length)}) is shorter than required minimum (${String(minLen)})`,
        })
        continue
      }

      if (rule.expectedPrefix && !val.startsWith(rule.expectedPrefix)) {
        invalidKeys.push({
          key: rule.key,
          reason: `Secret does not match required security prefix '${rule.expectedPrefix}'`,
        })
        continue
      }

      const entropy = calculateEntropy(val)
      if (entropy < minEntropy) {
        invalidKeys.push({
          key: rule.key,
          reason: `Secret Shannon entropy (${entropy.toFixed(2)}) is below required randomness floor (${String(minEntropy)})`,
        })
        continue
      }

      // Hash value to generate zero-knowledge digest for attestation binding
      const digest = createHash('sha256').update(val, 'utf8').digest('hex')
      verifiedDigests.push(`${rule.key}:${digest}`)
      verifiedKeys.push(rule.key)
    }

    const isAttested = missingKeys.length === 0 && invalidKeys.length === 0

    let attestationToken: string | null = null
    if (isAttested && verifiedKeys.length > 0) {
      const tokenPayload = [
        `policy:${policyId}`,
        `keys:${verifiedKeys.sort().join(',')}`,
        `hashes:${verifiedDigests.sort().join(',')}`,
      ].join(';')
      attestationToken = createHash('sha256').update(tokenPayload, 'utf8').digest('hex')
    }

    const summary = isAttested
      ? `Security attestation granted for policy '${policyId}' (${String(verifiedKeys.length)} secret(s) verified, zero plaintext leaked).`
      : `Security attestation denied for policy '${policyId}' (${String(missingKeys.length)} missing, ${String(invalidKeys.length)} invalid).`

    return {
      isAttested,
      policyId,
      attestationToken,
      verifiedKeys,
      missingKeys,
      invalidKeys,
      totalRulesAudited: rules.length,
      summary,
    }
  }
}
