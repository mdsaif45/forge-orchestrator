import { describe, expect, it } from 'vitest'
import { runtimeIdSchema } from '@forge/shared'
import {
  RuntimeRegistry,
  MockAgentRuntime,
  UnknownRuntimeError,
  SCENARIOS,
  bindRole,
  BindingSet,
  DEFAULT_ALLOWED_ENV_VARS,
  sanitizeRuntimeEnvironment,
  createResourceBudget,
  DEFAULT_RESOURCE_BUDGET,
  accountEnv,
  redactOutput,
  stripAnsi,
} from './index'

describe('@forge/runtimes package contract tests', () => {
  it('exports RuntimeRegistry and correctly handles runtime lifecycle and errors', () => {
    const registry = new RuntimeRegistry()
    const mock = new MockAgentRuntime({
      scenario: SCENARIOS.happy,
    })

    registry.register(mock)
    expect(registry.resolve(mock.id)).toBe(mock)
    expect(registry.list()).toContain(mock)

    const nonExistent = runtimeIdSchema.parse('non-existent')
    expect(() => registry.resolve(nonExistent)).toThrow(UnknownRuntimeError)
  })

  it('verifies role binding and capability resolution contracts', () => {
    const registry = new RuntimeRegistry()
    const mockId = runtimeIdSchema.parse('mock-agent')
    const mock = new MockAgentRuntime({
      id: mockId,
      scenario: SCENARIOS.happy,
    })
    registry.register(mock)

    const binding = bindRole(registry, {
      role: 'implementer',
      runtimeId: mockId,
    })

    expect(binding.role).toBe('implementer')
    expect(binding.runtimeId).toBe('mock-agent')

    const set = new BindingSet([binding])
    expect(set.get('implementer')?.runtimeId).toBe('mock-agent')
  })

  it('verifies environment sanitizer contracts', () => {
    expect(DEFAULT_ALLOWED_ENV_VARS).toContain('PATH')
    expect(DEFAULT_ALLOWED_ENV_VARS).toContain('HOME')

    const report = sanitizeRuntimeEnvironment({
      parentEnv: {
        PATH: '/usr/bin',
        FORGE_SECRET_TOKEN: 'super-secret',
        UNAPPROVED_VAR: 'value',
      },
      allowlist: ['PATH'],
      mode: 'strict',
    })

    expect(report.env.PATH).toBe('/usr/bin')
    expect(report.env.FORGE_SECRET_TOKEN).toBeUndefined()
    expect(report.withheldKeys).toContain('FORGE_SECRET_TOKEN')
    expect(report.withheldKeys).toContain('UNAPPROVED_VAR')
  })

  it('verifies resource budget contracts', () => {
    const budget = createResourceBudget({
      maxHeapMb: 256,
      maxRssBytes: 512 * 1024 * 1024,
    })

    expect(budget.maxHeapMb).toBe(256)
    expect(budget.maxRssBytes).toBe(512 * 1024 * 1024)
    expect(DEFAULT_RESOURCE_BUDGET.maxRssBytes).toBeGreaterThan(0)
  })

  it('verifies process utility contracts (redaction, ansi, accountEnv)', () => {
    expect(stripAnsi('\u001b[31mError\u001b[0m')).toBe('Error')
    expect(accountEnv('work')).toEqual({ HOME: 'work', USERPROFILE: 'work' })
    expect(redactOutput('nothing secret here')).toBe('nothing secret here')
  })
})
