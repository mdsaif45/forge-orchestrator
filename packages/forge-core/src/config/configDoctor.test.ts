import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { auditForgeEnvironment } from './configDoctor'

describe('auditForgeEnvironment', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'forge-doctor-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('reports healthy environment when database and filesystem are intact', async () => {
    const mockSqlite = {
      pragma: vi.fn().mockImplementation((pragmaName: string) => {
        if (pragmaName === 'integrity_check') return 'ok'
        if (pragmaName === 'foreign_key_check') return []
        return null
      }),
    } as unknown as Database.Database

    const report = await auditForgeEnvironment({
      dataDir: tempDir,
      sqlite: mockSqlite,
      timeoutMs: 100, // fast timeout for offline ollama
    })

    expect(report.healthy).toBe(true)
    expect(report.errorCount).toBe(0)
    expect(report.checks.some((c) => c.id === 'storage.dataDir' && c.status === 'ok')).toBe(true)
    expect(report.checks.some((c) => c.id === 'database.integrity' && c.status === 'ok')).toBe(true)
    expect(report.formattedSummary).toContain('HEALTHY')
  })

  it('detects database corruption and reports error (A2: Fail-closed)', async () => {
    const mockSqlite = {
      pragma: vi.fn().mockImplementation((pragmaName: string) => {
        if (pragmaName === 'integrity_check')
          return '*** in database user: Page 4: btreeInitPage() failed'
        if (pragmaName === 'foreign_key_check') return []
        return null
      }),
    } as unknown as Database.Database

    const report = await auditForgeEnvironment({
      dataDir: tempDir,
      sqlite: mockSqlite,
      timeoutMs: 100,
    })

    expect(report.healthy).toBe(false)
    expect(report.errorCount).toBeGreaterThanOrEqual(1)
    const dbCheck = report.checks.find((c) => c.id === 'database.integrity')
    expect(dbCheck?.status).toBe('error')
    expect(dbCheck?.remedy).toBeDefined()
    expect(report.formattedSummary).toContain('ISSUES DETECTED')
  })
})
