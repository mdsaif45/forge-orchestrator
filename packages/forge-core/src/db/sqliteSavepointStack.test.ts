import { describe, expect, it } from 'vitest'
import { SqliteSavepointStackManager, sanitizeSavepointName } from './sqliteSavepointStack'

describe('sqliteSavepointStack (STATE-019)', () => {
  it('sanitizes valid savepoint names and rejects illegal characters', () => {
    expect(sanitizeSavepointName('sp_valid_1')).toBe('sp_valid_1')
    expect(sanitizeSavepointName('checkpoint')).toBe('checkpoint')
    expect(() => sanitizeSavepointName('')).toThrow('Savepoint name cannot be empty')
    expect(() => sanitizeSavepointName('sp; DROP TABLE users;')).toThrow(
      'Invalid savepoint identifier',
    )
    expect(() => sanitizeSavepointName('sp-with-dashes')).toThrow('Invalid savepoint identifier')
  })

  it('pushes and pops savepoint frames with correct SQL statements', () => {
    const manager = new SqliteSavepointStackManager({ maxDepth: 5 })
    const { frame: f1, sql: s1 } = manager.push('stage_1')
    expect(f1.name).toBe('stage_1')
    expect(f1.depth).toBe(1)
    expect(s1).toBe('SAVEPOINT stage_1;')

    const { frame: f2, sql: s2 } = manager.push('stage_2')
    expect(f2.name).toBe('stage_2')
    expect(f2.depth).toBe(2)
    expect(s2).toBe('SAVEPOINT stage_2;')

    expect(manager.getStatus().currentDepth).toBe(2)
    expect(manager.getStatus().topSavepointName).toBe('stage_2')

    const { frame: popped, releaseSql } = manager.pop()
    expect(popped.name).toBe('stage_2')
    expect(releaseSql).toBe('RELEASE stage_2;')
    expect(manager.getStatus().currentDepth).toBe(1)
  })

  it('enforces maximum nesting depth limit', () => {
    const manager = new SqliteSavepointStackManager({ maxDepth: 2 })
    manager.push('sp1')
    manager.push('sp2')
    expect(() => manager.push('sp3')).toThrow('Maximum savepoint stack depth of 2 exceeded')
  })

  it('unwinds intermediate frames when rolling back to an ancestor savepoint', () => {
    const manager = new SqliteSavepointStackManager()
    manager.push('root')
    manager.push('child_a')
    manager.push('child_b')

    expect(manager.getStatus().currentDepth).toBe(3)

    const { unwoundFrames, rollbackSql } = manager.rollbackTo('root')
    expect(rollbackSql).toBe('ROLLBACK TO root;')
    expect(unwoundFrames.map((f) => f.name)).toEqual(['child_a', 'child_b'])
    expect(manager.getStatus().currentDepth).toBe(1)
    expect(manager.getStatus().topSavepointName).toBe('root')
  })

  it('rolls back all active savepoints and clears stack', () => {
    const manager = new SqliteSavepointStackManager()
    manager.push('first')
    manager.push('second')

    const { unwoundFrames, rollbackSqlStatements } = manager.rollbackAll()
    expect(unwoundFrames.length).toBe(2)
    expect(rollbackSqlStatements).toEqual(['ROLLBACK TO first;', 'RELEASE first;'])
    expect(manager.getStatus().currentDepth).toBe(0)
  })
})
