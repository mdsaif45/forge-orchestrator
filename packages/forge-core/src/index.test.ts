import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createForgeCore,
  resolveDataDir,
  calculateTokenCost,
  MODEL_PRICING_TABLE,
  ToolRateLimiter,
  ToolIdempotencyCache,
} from './index'

describe('@forge/core headless engine and task contracts', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'forge-core-pkg-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error on locked directory in Windows tests
    }
  })

  it('verifies resolveDataDir resolves directory paths correctly', () => {
    const explicit = resolveDataDir(tempDir)
    expect(explicit).toBe(tempDir)
  })

  it('boots ForgeCore headlessly with zero Electron dependencies and shuts down cleanly', async () => {
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

    // Verifies native agent and CLI catalog are registered
    expect(core.registry.has('forge-native-agent')).toBe(true)
    expect(core.registry.has('opencode')).toBe(true)
    expect(core.registry.has('codex')).toBe(true)

    await core.close()
  })

  it('verifies token accounting and pricing contracts', () => {
    expect(MODEL_PRICING_TABLE).toBeDefined()
    expect(Object.keys(MODEL_PRICING_TABLE).length).toBeGreaterThan(0)

    const estimate = calculateTokenCost('claude-3-5-sonnet', {
      promptTokens: 1000,
      completionTokens: 500,
    })
    expect(estimate.totalTokens).toBe(1500)
    expect(estimate.totalCostUsd).toBeGreaterThan(0)
  })

  it('verifies tool limiter and idempotency cache contracts', () => {
    const limiter = new ToolRateLimiter({
      capacity: 30,
      refillRatePerSec: 2,
      maxConcurrency: 3,
    })
    expect(limiter).toBeDefined()

    const cache = new ToolIdempotencyCache({
      defaultTtlMs: 5000,
      maxEntries: 100,
    })
    expect(cache).toBeDefined()
  })
})
