import { describe, expect, it } from 'vitest'
import { WorkspaceEnvSanitizer } from './workspaceEnvSanitizer'

describe('WorkspaceEnvSanitizer', () => {
  it('masks secret values properly', () => {
    expect(WorkspaceEnvSanitizer.maskSecret('')).toBe('')
    expect(WorkspaceEnvSanitizer.maskSecret('short')).toBe('[REDACTED]')
    expect(WorkspaceEnvSanitizer.maskSecret('sk-ant-api03-secret123456789xyz')).toBe('sk-***xyz')
  })

  it('strips high-risk cloud and provider secret variables fail-closed', () => {
    const sanitizer = new WorkspaceEnvSanitizer()
    const inbound = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/user',
      TEMP: '/tmp',
      SYSTEMROOT: 'C:\\Windows',
      AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      GITHUB_TOKEN: 'ghp_1234567890abcdef',
      PROVIDER_API_KEY: 'sk-ant-12345',
      SERVICE_API_KEY: 'sk-proj-98765',
      DB_PASSWORD: 'supersecretpassword',
      APP_PORT: '3000',
    }

    const report = sanitizer.sanitize(inbound)
    expect(report.originalCount).toBe(10)
    expect(report.retainedCount).toBe(5)
    expect(report.strippedKeys).toEqual([
      'AWS_SECRET_ACCESS_KEY',
      'DB_PASSWORD',
      'GITHUB_TOKEN',
      'PROVIDER_API_KEY',
      'SERVICE_API_KEY',
    ])
    expect(report.missingRequiredKeys).toEqual([])
    expect(report.sanitizedEnv.APP_PORT).toBe('3000')
    expect(report.sanitizedEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  })

  it('preserves system baseline keys across platform variants (e.g. USERPROFILE instead of HOME)', () => {
    const sanitizer = new WorkspaceEnvSanitizer()
    const inbound = {
      Path: 'C:\\Windows\\system32',
      USERPROFILE: 'C:\\Users\\Developer',
      TMP: 'C:\\Users\\Developer\\AppData\\Local\\Temp',
      SystemRoot: 'C:\\Windows',
      NODE_ENV: 'production',
    }

    const report = sanitizer.sanitize(inbound)
    expect(report.missingRequiredKeys).toEqual([])
    expect(report.sanitizedEnv.NODE_ENV).toBe('production')
    expect(report.strippedKeys).toHaveLength(0)
  })

  it('flags missing required system keys when baseline variables are omitted', () => {
    const sanitizer = new WorkspaceEnvSanitizer()
    const inbound = {
      APP_NAME: 'Forge',
    }

    const report = sanitizer.sanitize(inbound)
    expect(report.missingRequiredKeys).toContain('PATH')
    expect(report.missingRequiredKeys).toContain('HOME')
    expect(report.missingRequiredKeys).toContain('TEMP')
  })

  it('permits custom allowlist to override stripped secret patterns when explicitly declared', () => {
    const sanitizer = new WorkspaceEnvSanitizer()
    const inbound = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      TEMP: '/tmp',
      SYSTEMROOT: 'C:\\Windows',
      PUBLIC_API_KEY: 'safe-public-identifier',
      SECRET_PRIVATE_KEY: 'top-secret',
    }

    const report = sanitizer.sanitize(inbound, {
      customAllowlist: ['PUBLIC_API_KEY'],
    })

    expect(report.sanitizedEnv.PUBLIC_API_KEY).toBe('safe-public-identifier')
    expect(report.sanitizedEnv.SECRET_PRIVATE_KEY).toBeUndefined()
    expect(report.strippedKeys).toEqual(['SECRET_PRIVATE_KEY'])
  })
})
