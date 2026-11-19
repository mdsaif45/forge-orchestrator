import { describe, expect, it } from 'vitest'
import { sanitizeRuntimeEnvironment } from './environmentSanitizer'

describe('sanitizeRuntimeEnvironment', () => {
  const mockParentEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/forge',
    TEMP: '/tmp',
    RANDOM_USER_VAR: 'hello-world',
    AWS_SECRET_ACCESS_KEY: 'secret12345',
    GITHUB_TOKEN: 'ghp_abcdef123456',
    DB_PASSWORD: 'supersecretpassword',
    API_KEY: 'key-98765',
  }

  it('strips sensitive keys and undeclared variables in strict mode (Least Privilege A7)', () => {
    const report = sanitizeRuntimeEnvironment({
      parentEnv: mockParentEnv,
      mode: 'strict',
    })

    expect(report.mode).toBe('strict')
    expect(report.env.PATH).toBe('/usr/bin:/bin')
    expect(report.env.HOME).toBe('/home/forge')
    expect(report.env.TEMP).toBe('/tmp')

    // Undeclared arbitrary host variable should be withheld in strict mode
    expect(report.env.RANDOM_USER_VAR).toBeUndefined()
    expect(report.withheldKeys).toContain('RANDOM_USER_VAR')

    // Secrets must be strictly withheld
    expect(report.env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(report.env.GITHUB_TOKEN).toBeUndefined()
    expect(report.env.DB_PASSWORD).toBeUndefined()
    expect(report.env.API_KEY).toBeUndefined()

    expect(report.withheldKeys).toContain('AWS_SECRET_ACCESS_KEY')
    expect(report.withheldKeys).toContain('GITHUB_TOKEN')
    expect(report.withheldKeys).toContain('DB_PASSWORD')
    expect(report.withheldKeys).toContain('API_KEY')
  })

  it('passes non-secret variables in permissive mode while still stripping secrets', () => {
    const report = sanitizeRuntimeEnvironment({
      parentEnv: mockParentEnv,
      mode: 'permissive',
    })

    expect(report.mode).toBe('permissive')
    expect(report.env.RANDOM_USER_VAR).toBe('hello-world')
    expect(report.preservedKeys).toContain('RANDOM_USER_VAR')

    // Secrets are still withheld
    expect(report.env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(report.env.GITHUB_TOKEN).toBeUndefined()
  })

  it('injects execution context variables into child environment', () => {
    const report = sanitizeRuntimeEnvironment({
      parentEnv: mockParentEnv,
      context: {
        runId: 'run-123',
        stepId: 'step-456',
        worktreePath: '/repos/worktree-1',
        dataDir: '/var/forge',
        runtimeId: 'claude-cli',
      },
    })

    expect(report.env.FORGE_RUN_ID).toBe('run-123')
    expect(report.env.FORGE_STEP_ID).toBe('step-456')
    expect(report.env.FORGE_WORKTREE_PATH).toBe('/repos/worktree-1')
    expect(report.env.FORGE_DATA_DIR).toBe('/var/forge')
    expect(report.env.FORGE_RUNTIME_ID).toBe('claude-cli')
    expect(report.injectedKeys).toContain('FORGE_RUN_ID')
  })

  it('honors custom allowlist overrides', () => {
    const report = sanitizeRuntimeEnvironment({
      parentEnv: mockParentEnv,
      mode: 'strict',
      allowlist: ['RANDOM_USER_VAR', 'API_KEY'],
    })

    expect(report.env.RANDOM_USER_VAR).toBe('hello-world')
    expect(report.env.API_KEY).toBe('key-98765')
    expect(report.preservedKeys).toContain('API_KEY')
  })
})
