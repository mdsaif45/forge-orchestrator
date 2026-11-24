import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkGitAvailable,
  checkNodeVersion,
  checkStorageWritable,
  runHealthChecks,
} from './healthCheck'

describe('First-Run & System Health Checks (#47)', () => {
  it('passes node version check for v22 and rejects older versions', () => {
    expect(checkNodeVersion('22.14.0').ok).toBe(true)
    expect(checkNodeVersion('24.0.0').ok).toBe(true)
    expect(checkNodeVersion('20.10.0').ok).toBe(false)
    expect(checkNodeVersion('18.19.0').ok).toBe(false)
  })

  it('verifies git presence when command runs successfully', () => {
    const mockRunner = (): string => 'git version 2.45.0.windows.1'
    const result = checkGitAvailable(mockRunner)
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('2.45.0')
  })

  it('fails git check when git is missing or throws', () => {
    const brokenRunner = (): never => {
      throw new Error('Command not found: git')
    }
    const result = checkGitAvailable(brokenRunner)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('not installed')
  })

  it('verifies storage directory write access in tmpdir', () => {
    const testDir = join(tmpdir(), `forge-healthcheck-test-${String(Date.now())}`)
    const result = checkStorageWritable(testDir)
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('writable')
  })

  it('aggregates all checks into a comprehensive HealthCheckReport', () => {
    const testDir = join(tmpdir(), `forge-healthcheck-report-${String(Date.now())}`)
    const report = runHealthChecks(testDir)
    expect(typeof report.healthy).toBe('boolean')
    expect(report.checks.node).toBeDefined()
    expect(report.checks.git).toBeDefined()
    expect(report.checks.storage).toBeDefined()
  })
})
