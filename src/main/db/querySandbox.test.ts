import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { validateReadOnlySql, executeSandboxedQuery } from './querySandbox'

describe('querySandbox (STATE-015)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE test_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        cost REAL NOT NULL
      );
      INSERT INTO test_runs VALUES ('run-1', 'Build Job', 'completed', 0.05);
      INSERT INTO test_runs VALUES ('run-2', 'Test Job', 'completed', 0.12);
      INSERT INTO test_runs VALUES ('run-3', 'Deploy Job', 'failed', 0.08);
    `)
  })

  afterEach(() => {
    db.close()
  })

  describe('validateReadOnlySql', () => {
    it('accepts safe SELECT queries and strips comments and trailing semicolons', () => {
      const sql = `
        -- Fetch completed test runs
        SELECT id, name, status /* inline comment */
        FROM test_runs
        WHERE status = 'completed';
      `
      const result = validateReadOnlySql(sql)
      expect(result.isReadOnly).toBe(true)
      expect(result.queryType).toBe('SELECT')
      expect(result.sanitizedSql).not.toContain('--')
      expect(result.sanitizedSql).not.toContain('/*')
      expect(result.sanitizedSql.endsWith(';')).toBe(false)
    })

    it('accepts Common Table Expressions (WITH queries)', () => {
      const sql = `
        WITH summary AS (
          SELECT status, count(*) as count FROM test_runs GROUP BY status
        )
        SELECT * FROM summary;
      `
      const result = validateReadOnlySql(sql)
      expect(result.isReadOnly).toBe(true)
      expect(result.queryType).toBe('WITH')
    })

    it('allows semicolon inside string literals without false-positive chain detection', () => {
      const sql = "SELECT id, ';' as delimiter FROM test_runs WHERE name != 'semi;colon'"
      const result = validateReadOnlySql(sql)
      expect(result.isReadOnly).toBe(true)
      expect(result.queryType).toBe('SELECT')
    })

    it('rejects forbidden mutation keywords (INSERT, UPDATE, DELETE, DROP, PRAGMA, ATTACH)', () => {
      const queries = [
        'INSERT INTO test_runs VALUES ("run-4", "X", "pending", 0.0)',
        'UPDATE test_runs SET status = "failed"',
        'DELETE FROM test_runs WHERE id = "run-1"',
        'DROP TABLE test_runs',
        'ALTER TABLE test_runs ADD COLUMN extra TEXT',
        'PRAGMA table_info(test_runs)',
        'ATTACH DATABASE "other.db" AS other',
      ]

      for (const q of queries) {
        const result = validateReadOnlySql(q)
        expect(result.isReadOnly).toBe(false)
        expect(result.violationReason).toBeDefined()
      }
    })

    it('rejects multiple statements chained via semicolons', () => {
      const chainedSql = 'SELECT * FROM test_runs; DROP TABLE test_runs;'
      const result = validateReadOnlySql(chainedSql)
      expect(result.isReadOnly).toBe(false)
      expect(result.violationReason).toContain('Multiple SQL statements')
    })

    it('rejects empty queries or queries consisting only of comments', () => {
      expect(validateReadOnlySql('').isReadOnly).toBe(false)
      expect(validateReadOnlySql('-- just a comment\n/* block */').isReadOnly).toBe(false)
    })
  })

  describe('executeSandboxedQuery', () => {
    it('executes valid read-only query and retrieves columns and rows', () => {
      const sql = 'SELECT id, name, status, cost FROM test_runs ORDER BY cost ASC'
      const result = executeSandboxedQuery(db, sql)

      expect(result.valid).toBe(true)
      expect(result.rowCount).toBe(3)
      expect(result.truncated).toBe(false)
      expect(result.columns).toEqual(['id', 'name', 'status', 'cost'])
      expect(result.rows[0]?.id).toBe('run-1')
      expect(result.formattedSummary).toContain('[Sandbox Query Success]')
    })

    it('enforces maxRows truncation limit when specified', () => {
      const sql = 'SELECT id FROM test_runs'
      const result = executeSandboxedQuery(db, sql, { maxRows: 2 })

      expect(result.valid).toBe(true)
      expect(result.rowCount).toBe(2)
      expect(result.truncated).toBe(true)
      expect(result.rows.length).toBe(2)
      expect(result.formattedSummary).toContain('truncated from 3')
    })

    it('generates query plan when includePlan is enabled', () => {
      const sql = "SELECT * FROM test_runs WHERE id = 'run-2'"
      const result = executeSandboxedQuery(db, sql, { includePlan: true })

      expect(result.valid).toBe(true)
      expect(result.queryPlan).toBeDefined()
      expect(Array.isArray(result.queryPlan)).toBe(true)
      expect(result.queryPlan?.length).toBeGreaterThan(0)
    })

    it('rejects mutation attempts and returns valid: false with error details', () => {
      const sql = 'DELETE FROM test_runs'
      const result = executeSandboxedQuery(db, sql)

      expect(result.valid).toBe(false)
      expect(result.rowCount).toBe(0)
      expect(result.error).toBeDefined()
      expect(result.formattedSummary).toContain('[Sandbox Query Rejected]')

      // Assert table rows were not touched
      const check = db.prepare('SELECT count(*) as count FROM test_runs').get() as { count: number }
      expect(check.count).toBe(3)
    })

    it('catches runtime SQLite syntax errors gracefully without throwing', () => {
      const sql = 'SELECT non_existent_column FROM test_runs'
      const result = executeSandboxedQuery(db, sql)

      expect(result.valid).toBe(false)
      expect(result.error).toContain('no such column')
      expect(result.formattedSummary).toContain('[Sandbox Query Execution Error]')
    })
  })
})
