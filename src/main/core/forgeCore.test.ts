import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createForgeCore, resolveDataDir } from './forgeCore'

describe('resolveDataDir', () => {
  const originalEnv = process.env.FORGE_DATA_DIR

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.FORGE_DATA_DIR = originalEnv
    } else {
      delete process.env.FORGE_DATA_DIR
    }
  })

  it('prefers explicit argument over environment variable and fallback', () => {
    process.env.FORGE_DATA_DIR = '/env/path'
    const result = resolveDataDir('/explicit/path')
    expect(result).toContain('explicit')
  })

  it('uses FORGE_DATA_DIR when explicit argument is absent', () => {
    process.env.FORGE_DATA_DIR = join(tmpdir(), 'forge-env-test')
    const result = resolveDataDir()
    expect(result).toContain('forge-env-test')
  })

  it('falls back to default platform directory when neither is specified', () => {
    delete process.env.FORGE_DATA_DIR
    const result = resolveDataDir()
    expect(result.length).toBeGreaterThan(0)
    expect(result).toContain('forge')
  })
})

describe('createForgeCore', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'forge-core-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore temp cleanup errors
    }
  })

  it('initializes a headless core with all domain services and closes cleanly', async () => {
    const core = createForgeCore({ dataDir: tempDir })

    expect(core.dataDir).toBe(tempDir)
    expect(core.db).toBeDefined()
    expect(core.projects).toBeDefined()
    expect(core.workflows).toBeDefined()
    expect(core.questions).toBeDefined()
    expect(core.decisions).toBeDefined()
    expect(core.changeSets).toBeDefined()
    expect(core.accounts).toBeDefined()
    expect(core.terminal).toBeDefined()
    expect(core.registry).toBeDefined()
    expect(core.runs).toBeDefined()
    expect(core.artifacts).toBeDefined()
    expect(core.artifactStore).toBeDefined()

    // Native agent runtime is registered
    expect(core.registry.has('forge-native-agent')).toBe(true)
    const nativeRuntime = core.registry.resolve('forge-native-agent')
    expect(nativeRuntime.simulated).toBe(false)

    // Standard CLI catalog agents are registered
    expect(core.registry.has('opencode')).toBe(true)
    expect(core.registry.has('codex')).toBe(true)

    // Close releases database lock and process resources
    await core.close()
  })
})
