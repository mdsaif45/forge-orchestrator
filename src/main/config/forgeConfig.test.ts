import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyEnvOverrides,
  findForgeConfigFile,
  getForgeConfigValue,
  loadForgeConfig,
  saveForgeConfig,
  setForgeConfigValue,
  type ForgeConfig,
} from './forgeConfig'

describe('forgeConfig (CORE-003)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `forge-config-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignored
    }
  })

  it('returns empty defaults when no config file exists and no env overrides are present', () => {
    const config = loadForgeConfig({
      searchFrom: tempDir,
      env: {},
    })

    expect(config).toEqual({})
  })

  it('loads valid .forgerc JSON configuration correctly', () => {
    const configPath = join(tempDir, '.forgerc')
    const fileContent: ForgeConfig = {
      defaultRuntime: 'custom:opencode',
      logLevel: 'debug',
      telemetry: false,
      security: {
        allowExecutionOutsideWorkspace: false,
        maxExecutionTimeMs: 60000,
      },
      customRuntimes: [
        {
          id: 'custom:opencode',
          name: 'OpenCode CLI',
          command: 'opencode',
          argsTemplate: ['--prompt', '{{prompt}}'],
          capabilities: ['repo-read', 'file-write', 'plan'],
        },
      ],
    }

    writeFileSync(configPath, JSON.stringify(fileContent, null, 2), 'utf8')

    const loaded = loadForgeConfig({
      searchFrom: tempDir,
      env: {},
    })

    expect(loaded.defaultRuntime).toBe('custom:opencode')
    expect(loaded.logLevel).toBe('debug')
    expect(loaded.telemetry).toBe(false)
    expect(loaded.security?.maxExecutionTimeMs).toBe(60000)
    expect(loaded.customRuntimes).toHaveLength(1)
    expect(loaded.customRuntimes?.[0]?.command).toBe('opencode')
  })

  it('supports JSONC comments in .forgerc', () => {
    const configPath = join(tempDir, '.forgerc.json')
    const rawContent = `
      // Top level forge configuration
      {
        /* runtime settings */
        "defaultRuntime": "forge-native-agent",
        "logLevel": "warn"
      }
    `
    writeFileSync(configPath, rawContent, 'utf8')

    const loaded = loadForgeConfig({
      searchFrom: tempDir,
      env: {},
    })

    expect(loaded.defaultRuntime).toBe('forge-native-agent')
    expect(loaded.logLevel).toBe('warn')
  })

  it('fails closed when configuration file has schema violations', () => {
    const configPath = join(tempDir, '.forgerc')
    // invalid logLevel value and unexpected keys
    writeFileSync(
      configPath,
      JSON.stringify({
        logLevel: 'verbose-invalid',
        unrecognizedKey: 'boom',
      }),
      'utf8',
    )

    expect(() =>
      loadForgeConfig({
        searchFrom: tempDir,
        env: {},
      }),
    ).toThrow(/Failed to parse Forge config/)
  })

  it('traverses upwards to locate .forgerc in a parent directory', () => {
    const configPath = join(tempDir, '.forgerc')
    writeFileSync(configPath, JSON.stringify({ logLevel: 'info' }), 'utf8')

    const subDir = join(tempDir, 'sub', 'nested')
    mkdirSync(subDir, { recursive: true })

    const found = findForgeConfigFile(subDir, undefined, {})
    expect(found).toBe(configPath)

    const loaded = loadForgeConfig({
      searchFrom: subDir,
      env: {},
    })
    expect(loaded.logLevel).toBe('info')
  })

  it('honors explicitPath with highest priority', () => {
    const explicitConfig = join(tempDir, 'custom.config.json')
    writeFileSync(explicitConfig, JSON.stringify({ logLevel: 'error' }), 'utf8')

    // Local .forgerc that should be overridden by explicitPath
    writeFileSync(join(tempDir, '.forgerc'), JSON.stringify({ logLevel: 'debug' }), 'utf8')

    const loaded = loadForgeConfig({
      searchFrom: tempDir,
      explicitPath: explicitConfig,
      env: {},
    })

    expect(loaded.logLevel).toBe('error')
  })

  it('applies environment variable overrides over file configuration', () => {
    const configPath = join(tempDir, '.forgerc')
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultRuntime: 'mock:default',
        logLevel: 'info',
        telemetry: false,
      }),
      'utf8',
    )

    const loaded = loadForgeConfig({
      searchFrom: tempDir,
      env: {
        FORGE_DATA_DIR: join(tempDir, 'override-data'),
        FORGE_DEFAULT_RUNTIME: 'claude',
        FORGE_LOG_LEVEL: 'debug',
        FORGE_TELEMETRY: 'true',
      },
    })

    expect(loaded.dataDir).toBe(join(tempDir, 'override-data'))
    expect(loaded.defaultRuntime).toBe('claude')
    expect(loaded.logLevel).toBe('debug')
    expect(loaded.telemetry).toBe(true)
  })

  it('applyEnvOverrides handles valid boolean and level representations', () => {
    const base: ForgeConfig = {
      defaultRuntime: 'initial',
      logLevel: 'info',
    }

    const overridden = applyEnvOverrides(base, {
      FORGE_DEFAULT_RUNTIME: 'new-runtime',
      FORGE_LOG_LEVEL: 'WARN',
      FORGE_TELEMETRY: '1',
    })

    expect(overridden.defaultRuntime).toBe('new-runtime')
    expect(overridden.logLevel).toBe('warn')
    expect(overridden.telemetry).toBe(true)
  })

  it('saveForgeConfig persists valid configuration to disk', () => {
    const configPath = join(tempDir, '.forgerc')
    const config: ForgeConfig = {
      defaultRuntime: 'custom:aider',
      logLevel: 'debug',
      telemetry: false,
    }

    saveForgeConfig(configPath, config)
    const loaded = loadForgeConfig({ explicitPath: configPath, env: {} })

    expect(loaded.defaultRuntime).toBe('custom:aider')
    expect(loaded.logLevel).toBe('debug')
    expect(loaded.telemetry).toBe(false)
  })

  it('getForgeConfigValue and setForgeConfigValue inspect and update nested settings', () => {
    const configPath = join(tempDir, '.forgerc')
    const initial: ForgeConfig = {
      logLevel: 'info',
      security: {
        maxExecutionTimeMs: 30000,
      },
    }
    saveForgeConfig(configPath, initial)

    // Inspect
    const loaded = loadForgeConfig({ explicitPath: configPath, env: {} })
    expect(getForgeConfigValue('logLevel', loaded)).toBe('info')
    expect(getForgeConfigValue('security.maxExecutionTimeMs', loaded)).toBe(30000)
    expect(getForgeConfigValue('nonexistent.key', loaded)).toBeUndefined()

    // Update existing and new nested key
    const res1 = setForgeConfigValue('logLevel', 'warn', configPath)
    expect(res1.previousValue).toBe('info')
    expect(res1.newValue).toBe('warn')

    const res2 = setForgeConfigValue('security.allowExecutionOutsideWorkspace', 'true', configPath)
    expect(res2.previousValue).toBeUndefined()
    expect(res2.newValue).toBe(true)

    const updated = loadForgeConfig({ explicitPath: configPath, env: {} })
    expect(updated.logLevel).toBe('warn')
    expect(updated.security?.maxExecutionTimeMs).toBe(30000)
    expect(updated.security?.allowExecutionOutsideWorkspace).toBe(true)
  })

  it('setForgeConfigValue fails closed when setting invalid values', () => {
    const configPath = join(tempDir, '.forgerc')
    saveForgeConfig(configPath, { logLevel: 'info' })

    // Invalid log level
    expect(() => {
      setForgeConfigValue('logLevel', 'invalid-level', configPath)
    }).toThrow()

    // Invalid maxExecutionTimeMs (must be positive number)
    expect(() => {
      setForgeConfigValue('security.maxExecutionTimeMs', -100, configPath)
    }).toThrow()
  })
})
