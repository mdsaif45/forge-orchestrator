import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listConfigPresets,
  generateConfigTemplate,
  writeConfigTemplate,
  type ConfigPresetName,
} from './configTemplateGenerator'
import { forgeConfigSchema } from './forgeConfig'

describe('ConfigTemplateGenerator (CONFIG-013)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'forge-config-test-'))
  })

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('lists all supported presets with metadata', () => {
    const presets = listConfigPresets()
    expect(presets.length).toBeGreaterThanOrEqual(5)
    const ids = presets.map((p) => p.id)
    expect(ids).toContain('node-ts')
    expect(ids).toContain('python')
    expect(ids).toContain('rust')
    expect(ids).toContain('go')
    expect(ids).toContain('minimal')
  })

  it('generates schema-valid configuration for each preset', () => {
    const presetNames: ConfigPresetName[] = ['node-ts', 'python', 'rust', 'go', 'minimal']
    for (const name of presetNames) {
      const template = generateConfigTemplate(name)
      expect(template.dataDir).toBe('.forge')
      expect(template.defaultRuntime).toBe('agent:orchestrator')
      const validation = forgeConfigSchema.safeParse(template)
      expect(validation.success).toBe(true)
    }
  })

  it('throws an error for unsupported presets', () => {
    expect(() => generateConfigTemplate('invalid' as unknown as ConfigPresetName)).toThrow(
      /unknown configuration preset/i,
    )
  })

  it('applies custom overrides cleanly', () => {
    const customized = generateConfigTemplate('minimal', {
      logLevel: 'debug',
      dataDir: '.custom-forge',
    })
    expect(customized.logLevel).toBe('debug')
    expect(customized.dataDir).toBe('.custom-forge')
  })

  it('writes config template file to target directory', () => {
    const res = writeConfigTemplate({
      preset: 'node-ts',
      targetDir: tempDir,
      filename: '.forgerc',
    })

    expect(res.created).toBe(true)
    expect(res.valid).toBe(true)
    expect(existsSync(res.path)).toBe(true)

    const raw = readFileSync(res.path, 'utf8')
    const parsed = JSON.parse(raw) as { customRuntimes: unknown[] }
    expect(parsed.customRuntimes).toBeDefined()
    expect(parsed.customRuntimes.length).toBeGreaterThan(0)
  })

  it('respects overwrite guards unless force is true', () => {
    writeConfigTemplate({
      preset: 'minimal',
      targetDir: tempDir,
      filename: '.forgerc',
    })

    // Second write without force should fail
    const duplicate = writeConfigTemplate({
      preset: 'minimal',
      targetDir: tempDir,
      filename: '.forgerc',
      force: false,
    })
    expect(duplicate.created).toBe(false)
    expect(duplicate.error).toMatch(/already exists/i)

    // With force it should succeed
    const forced = writeConfigTemplate({
      preset: 'minimal',
      targetDir: tempDir,
      filename: '.forgerc',
      force: true,
    })
    expect(forced.created).toBe(true)
  })
})
