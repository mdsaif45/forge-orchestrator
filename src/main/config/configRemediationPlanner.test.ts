import { describe, expect, it } from 'vitest'
import { type ConfigPolicyBaseline, planConfigRemediation } from './configRemediationPlanner'

describe('planConfigRemediation', () => {
  const samplePolicy: ConfigPolicyBaseline = {
    policyName: 'enterprise-security-baseline',
    rules: {
      logLevel: {
        key: 'logLevel',
        required: true,
        defaultValue: 'info',
        allowedValues: ['debug', 'info', 'warn', 'error'],
      },
      sandboxEnabled: {
        key: 'sandboxEnabled',
        required: true,
        defaultValue: true,
      },
      insecureDebugPort: {
        key: 'insecureDebugPort',
        forbidden: true,
      },
      legacyTelemetry: {
        key: 'legacyTelemetry',
        deprecated: true,
        defaultValue: false,
      },
    },
  }

  it('evaluates compliant configuration with zero actions and 100% compliance', () => {
    const config = {
      logLevel: 'info',
      sandboxEnabled: true,
    }
    const plan = planConfigRemediation(config, samplePolicy)
    expect(plan.isCompliant).toBe(true)
    expect(plan.driftCount).toBe(0)
    expect(plan.complianceScore).toBe(1)
    expect(plan.actions).toHaveLength(0)
    expect(plan.summary).toContain('COMPLIANT')
  })

  it('detects missing required keys and proposes SET_DEFAULT action', () => {
    const config = {
      logLevel: 'info',
    }
    const plan = planConfigRemediation(config, samplePolicy)
    expect(plan.isCompliant).toBe(false)
    expect(plan.driftCount).toBe(1)
    const action = plan.actions[0]
    expect(action?.type).toBe('SET_DEFAULT')
    expect(action?.key).toBe('sandboxEnabled')
    expect(action?.suggestedValue).toBe(true)
    expect(plan.patchPreview.sandboxEnabled).toBe(true)
  })

  it('detects forbidden keys and proposes REMOVE_FORBIDDEN action', () => {
    const config = {
      logLevel: 'info',
      sandboxEnabled: true,
      insecureDebugPort: 9229,
    }
    const plan = planConfigRemediation(config, samplePolicy)
    expect(plan.isCompliant).toBe(false)
    const action = plan.actions.find((a) => a.key === 'insecureDebugPort')
    expect(action?.type).toBe('REMOVE_FORBIDDEN')
    expect('insecureDebugPort' in plan.patchPreview).toBe(false)
  })

  it('detects disallowed values and proposes FIX_DISALLOWED action', () => {
    const config = {
      logLevel: 'verbose', // not in allowedValues ['debug', 'info', 'warn', 'error']
      sandboxEnabled: true,
    }
    const plan = planConfigRemediation(config, samplePolicy)
    expect(plan.isCompliant).toBe(false)
    const action = plan.actions.find((a) => a.key === 'logLevel')
    expect(action?.type).toBe('FIX_DISALLOWED')
    expect(action?.suggestedValue).toBe('info')
    expect(plan.patchPreview.logLevel).toBe('info')
  })

  it('flags unrecognized keys when strict is true and produces clean patch preview', () => {
    const config = {
      logLevel: 'debug',
      sandboxEnabled: true,
      rogueCustomKey: 'unsafe-val',
    }
    const plan = planConfigRemediation(config, samplePolicy, { strict: true })
    expect(plan.isCompliant).toBe(false)
    const rogueAction = plan.actions.find((a) => a.key === 'rogueCustomKey')
    expect(rogueAction?.type).toBe('REMOVE_FORBIDDEN')
    expect('rogueCustomKey' in plan.patchPreview).toBe(false)
    expect(plan.patchPreview.logLevel).toBe('debug')
  })
})
