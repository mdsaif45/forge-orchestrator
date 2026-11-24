import { describe, expect, it } from 'vitest'
import {
  auditConfigAgainstPolicies,
  resolveHierarchicalConfig,
  type PolicyLockRule,
} from './configPolicyEngine'

describe('Hierarchical Configuration Inheritance & Administrative Policy Lock (CONFIG-006)', () => {
  it('resolves hierarchical configuration with proper tier precedence and lineage', () => {
    const tiers = {
      global: {
        logLevel: 'warn' as const,
        telemetry: false,
        security: {
          allowExecutionOutsideWorkspace: false,
          maxExecutionTimeMs: 60000,
        },
      },
      workspace: {
        logLevel: 'info' as const,
      },
      cli: {
        logLevel: 'debug' as const,
      },
    }

    const { effectiveConfig, lineage } = resolveHierarchicalConfig(tiers)

    expect(effectiveConfig.logLevel).toBe('debug') // CLI overrides workspace and global
    expect(effectiveConfig.telemetry).toBe(false) // from global
    expect(effectiveConfig.security?.allowExecutionOutsideWorkspace).toBe(false)
    expect(effectiveConfig.security?.maxExecutionTimeMs).toBe(60000)

    expect(lineage.logLevel?.definedInTier).toBe('cli')
    expect(lineage.telemetry?.definedInTier).toBe('global')
    expect(lineage['security.allowExecutionOutsideWorkspace']?.definedInTier).toBe('global')
  })

  it('fails closed when a lower tier attempts to override a locked policy key', () => {
    const policies: PolicyLockRule[] = [
      {
        key: 'security.allowExecutionOutsideWorkspace',
        disallowOverride: true,
        description: 'Mandatory workspace sandbox isolation',
      },
    ]

    const tiers = {
      global: {
        security: {
          allowExecutionOutsideWorkspace: false,
        },
      },
      workspace: {
        security: {
          allowExecutionOutsideWorkspace: true, // violation!
        },
      },
    }

    const result = auditConfigAgainstPolicies(tiers, policies)

    expect(result.valid).toBe(false)
    expect(result.violations.length).toBe(1)
    expect(result.violations[0]?.key).toBe('security.allowExecutionOutsideWorkspace')
    expect(result.violations[0]?.attemptedTier).toBe('workspace')
    expect(result.effectiveConfig).toBeUndefined()
    expect(result.formattedSummary).toContain('ADMINISTRATIVE POLICY AUDIT FAILED')
    expect(result.formattedSummary).toContain('Workspace config overrides locked policy key')
  })

  it('fails closed when any tier violates an enforced lockedValue', () => {
    const policies: PolicyLockRule[] = [
      {
        key: 'telemetry',
        lockedValue: false,
        disallowOverride: true,
        description: 'Strict corporate telemetry disallowance',
      },
    ]

    const tiers = {
      global: {
        telemetry: true, // violates enforced lockedValue
      },
    }

    const result = auditConfigAgainstPolicies(tiers, policies)

    expect(result.valid).toBe(false)
    expect(result.violations.length).toBe(1)
    expect(result.violations[0]?.reason).toContain('administrative policy strictly enforces false')
  })

  it('passes audit and returns resolved effective config when all policies are respected', () => {
    const policies: PolicyLockRule[] = [
      {
        key: 'security.allowExecutionOutsideWorkspace',
        lockedValue: false,
        disallowOverride: true,
        description: 'Mandatory workspace sandbox isolation',
      },
    ]

    const tiers = {
      global: {
        security: {
          allowExecutionOutsideWorkspace: false,
        },
      },
      workspace: {
        logLevel: 'info' as const,
      },
    }

    const result = auditConfigAgainstPolicies(tiers, policies)

    expect(result.valid).toBe(true)
    expect(result.violations).toHaveLength(0)
    expect(result.effectiveConfig?.security?.allowExecutionOutsideWorkspace).toBe(false)
    expect(result.effectiveConfig?.logLevel).toBe('info')
    expect(result.formattedSummary).toContain('ADMINISTRATIVE POLICY AUDIT PASSED')
  })
})
