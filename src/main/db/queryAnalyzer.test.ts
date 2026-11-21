import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { parseQueryPlanRows, analyzeQueryPlan, auditTableIndexes } from './queryAnalyzer'

describe('queryAnalyzer (STATE-016)', () => {
  describe('parseQueryPlanRows', () => {
    it('identifies sequential table scans and lowers efficiency score', () => {
      const planRows = [
        { id: 2, parent: 0, detail: 'SCAN TABLE runs' },
        { id: 3, parent: 0, detail: 'USE TEMP B-TREE FOR ORDER BY' },
      ]

      const analysis = parseQueryPlanRows('SELECT * FROM runs ORDER BY created_at', planRows)

      expect(analysis.hasTableScan).toBe(true)
      expect(analysis.scannedTables).toEqual(['runs'])
      expect(analysis.usesTempBTree).toBe(true)
      expect(analysis.score).toBe(100 - 35 - 15) // 50
      expect(analysis.recommendations.length).toBe(2)
      expect(analysis.formattedSummary).toContain('Score: 50/100')
    })

    it('identifies index searches and awards optimal score', () => {
      const planRows = [
        {
          id: 2,
          parent: 0,
          detail: 'SEARCH TABLE runs USING INDEX idx_runs_status (status=?)',
        },
      ]

      const analysis = parseQueryPlanRows('SELECT * FROM runs WHERE status = ?', planRows)

      expect(analysis.hasTableScan).toBe(false)
      expect(analysis.scannedTables).toHaveLength(0)
      expect(analysis.usedIndexes).toEqual(['idx_runs_status'])
      expect(analysis.usesTempBTree).toBe(false)
      expect(analysis.score).toBe(100)
      expect(analysis.recommendations[0]).toContain('optimal')
    })
  })

  describe('analyzeQueryPlan and auditTableIndexes with in-memory database', () => {
    it('analyzes unindexed vs indexed query plans on real SQLite instance', () => {
      const db = new Database(':memory:')
      db.exec(`
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          category TEXT,
          val INTEGER
        );
      `)

      // Unindexed query on category
      const unindexedAnalysis = analyzeQueryPlan(db, "SELECT * FROM items WHERE category = 'test'")
      expect(unindexedAnalysis.hasTableScan).toBe(true)
      expect(unindexedAnalysis.scannedTables).toContain('items')
      expect(unindexedAnalysis.score).toBe(65)

      // Add index
      db.exec('CREATE INDEX idx_items_category ON items (category);')

      // Indexed query on category
      const indexedAnalysis = analyzeQueryPlan(db, "SELECT * FROM items WHERE category = 'test'")
      expect(indexedAnalysis.hasTableScan).toBe(false)
      expect(indexedAnalysis.usedIndexes).toContain('idx_items_category')
      expect(indexedAnalysis.score).toBe(100)

      db.close()
    })

    it('audits table indexes correctly', () => {
      const db = new Database(':memory:')
      db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE,
          age INTEGER
        );
        CREATE INDEX idx_users_age ON users (age);
      `)

      const audit = auditTableIndexes(db)
      expect(audit.totalTables).toBe(1)
      expect(audit.totalIndexes).toBeGreaterThanOrEqual(2) // sqlite creates autoindex for UNIQUE/PK
      expect(audit.tables[0]?.tableName).toBe('users')
      expect(audit.formattedSummary).toContain('[Index Audit] Audited 1 tables')

      db.close()
    })
  })
})
