import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootstrapForgeConfig } from './configBootstrapper'
import { loadForgeConfig } from './forgeConfig'

describe('Config Bootstrapper & Setup Generator (CONFIG-005)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'config-bootstrap-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('generates a valid .forgerc with defaults when none exists', async () => {
    const result = await bootstrapForgeConfig({
      cwd: tempDir,
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
    })

    expect(result.valid).toBe(true)
    expect(result.created).toBe(true)
    expect(result.config?.providers?.ollama?.model).toBe('qwen2.5-coder:7b')
    expect(result.formattedSummary).toContain('FORGE WORKSPACE CONFIGURATION INITIALIZED')

    // Confirm that loadForgeConfig parses it successfully
    const loaded = loadForgeConfig({ searchFrom: tempDir })
    expect(loaded.activeProfile).toBe('local')
  })

  it('detects package.json scripts when bootstrapping configuration', async () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'vitest run',
          build: 'tsc -p tsconfig.json',
        },
      }),
      'utf8',
    )

    const result = await bootstrapForgeConfig({
      cwd: tempDir,
    })

    expect(result.valid).toBe(true)
    expect(result.formattedSummary).toContain('Test Command:   npm test')
    expect(result.formattedSummary).toContain('Build Command:  npm run build')
  })

  it('fails closed when .forgerc already exists unless force=true', async () => {
    await bootstrapForgeConfig({ cwd: tempDir })

    // Second bootstrap without force must fail closed
    const conflictResult = await bootstrapForgeConfig({ cwd: tempDir })
    expect(conflictResult.valid).toBe(false)
    expect(conflictResult.created).toBe(false)
    expect(conflictResult.error).toContain('Configuration file already exists')

    // Second bootstrap with force=true must succeed
    const forcedResult = await bootstrapForgeConfig({ cwd: tempDir, force: true })
    expect(forcedResult.valid).toBe(true)
    expect(forcedResult.created).toBe(true)
  })
})
