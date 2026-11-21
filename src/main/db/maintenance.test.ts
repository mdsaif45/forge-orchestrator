import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { getDatabaseStats, initialiseDatabase, vacuumDatabase } from './index'

describe('database maintenance', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'forge-db-maintenance-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('collects storage and table statistics for an initialized database', () => {
    const dbFile = join(tempDir, 'forge.db')
    const { sqlite, close } = initialiseDatabase(dbFile)

    try {
      const stats = getDatabaseStats(sqlite, dbFile)
      expect(stats.pageSize).toBeGreaterThan(0)
      expect(stats.pageCount).toBeGreaterThan(0)
      expect(stats.totalSizeBytes).toBeGreaterThan(0)
      expect(stats.diskSizeBytes).toBeGreaterThan(0)
      expect(Array.isArray(stats.tables)).toBe(true)

      // Verifies migration created core tables
      const tableNames = stats.tables.map((t) => t.tableName)
      expect(tableNames).toContain('projects')
      expect(tableNames).toContain('workflows')
      expect(tableNames).toContain('events')
    } finally {
      close()
    }
  })

  it('vacuums and compacts an existing database', () => {
    const dbFile = join(tempDir, 'forge.db')
    const { sqlite, close } = initialiseDatabase(dbFile)

    try {
      // Insert temporary data and delete it to produce freelist pages
      sqlite.exec('CREATE TABLE temp_blobs (id INTEGER PRIMARY KEY, data TEXT)')
      const insert = sqlite.prepare('INSERT INTO temp_blobs (data) VALUES (?)')
      const blob = 'x'.repeat(10000)
      for (let i = 0; i < 50; i++) {
        insert.run(blob)
      }
      sqlite.exec('DELETE FROM temp_blobs')

      const statsBefore = getDatabaseStats(sqlite, dbFile)
      expect(statsBefore.freelistCount).toBeGreaterThan(0)

      const result = vacuumDatabase(sqlite, dbFile)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)

      const statsAfter = getDatabaseStats(sqlite, dbFile)
      expect(statsAfter.freelistCount).toBe(0)
    } finally {
      close()
    }
  })
})
