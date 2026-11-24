import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listForgeProfiles,
  loadForgeConfig,
  switchForgeProfile,
  type ForgeConfig,
} from './forgeConfig'

describe('ForgeConfig Profiles (CONFIG-002)', () => {
  let tempDir: string
  let configPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'forge-profile-test-'))
    configPath = join(tempDir, '.forgerc')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('loads base configuration when no profile is active', () => {
    const config: ForgeConfig = {
      defaultRuntime: 'native',
      logLevel: 'info',
      profiles: {
        dev: {
          defaultRuntime: 'custom:aider',
          logLevel: 'debug',
        },
      },
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

    const loaded = loadForgeConfig({ explicitPath: configPath, env: {} })
    expect(loaded.defaultRuntime).toBe('native')
    expect(loaded.logLevel).toBe('info')
  })

  it('applies profile overrides when activeProfile is set in config', () => {
    const config: ForgeConfig = {
      defaultRuntime: 'native',
      logLevel: 'info',
      activeProfile: 'dev',
      profiles: {
        dev: {
          defaultRuntime: 'custom:aider',
          logLevel: 'debug',
        },
      },
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

    const loaded = loadForgeConfig({ explicitPath: configPath, env: {} })
    expect(loaded.defaultRuntime).toBe('custom:aider')
    expect(loaded.logLevel).toBe('debug')
  })

  it('overrides activeProfile via FORGE_PROFILE environment variable', () => {
    const config: ForgeConfig = {
      defaultRuntime: 'native',
      logLevel: 'info',
      activeProfile: 'dev',
      profiles: {
        dev: {
          defaultRuntime: 'custom:aider',
        },
        prod: {
          defaultRuntime: 'claude-cli',
          logLevel: 'warn',
        },
      },
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

    const loaded = loadForgeConfig({
      explicitPath: configPath,
      env: { FORGE_PROFILE: 'prod' },
    })
    expect(loaded.defaultRuntime).toBe('claude-cli')
    expect(loaded.logLevel).toBe('warn')
  })

  it('overrides activeProfile via explicit option.profile', () => {
    const config: ForgeConfig = {
      defaultRuntime: 'native',
      activeProfile: 'dev',
      profiles: {
        dev: { defaultRuntime: 'custom:aider' },
        testing: { defaultRuntime: 'mock-runtime' },
      },
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

    const loaded = loadForgeConfig({
      explicitPath: configPath,
      profile: 'testing',
      env: { FORGE_PROFILE: 'dev' },
    })
    expect(loaded.defaultRuntime).toBe('mock-runtime')
  })

  it('lists available profiles and identifies the active profile', () => {
    const config: ForgeConfig = {
      activeProfile: 'staging',
      profiles: {
        dev: { logLevel: 'debug' },
        staging: { logLevel: 'info' },
        production: { logLevel: 'warn' },
      },
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

    const result = listForgeProfiles(tempDir, configPath, {})
    expect(result.activeProfile).toBe('staging')
    expect(result.profiles).toEqual(['dev', 'production', 'staging'])
  })

  it('switches active profile in .forgerc cleanly', () => {
    const config: ForgeConfig = {
      activeProfile: 'dev',
      profiles: {
        dev: { logLevel: 'debug' },
        production: { logLevel: 'warn' },
      },
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

    const switchResult = switchForgeProfile('production', configPath)
    expect(switchResult.previousProfile).toBe('dev')
    expect(switchResult.newProfile).toBe('production')

    const updated = loadForgeConfig({ explicitPath: configPath, env: {} })
    expect(updated.activeProfile).toBe('production')
    expect(updated.logLevel).toBe('warn')
  })

  it('throws when switching to a non-existent profile', () => {
    const config: ForgeConfig = {
      profiles: {
        dev: { logLevel: 'debug' },
      },
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

    expect(() => switchForgeProfile('non-existent', configPath)).toThrow(
      /Profile "non-existent" not found/,
    )
  })
})
