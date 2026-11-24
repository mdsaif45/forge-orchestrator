import type Database from 'better-sqlite3'

export interface SavepointReceipt {
  readonly savepointName: string
  readonly action: 'create' | 'release' | 'rollback'
  readonly depth: number
  readonly timestamp: number
}

const SAVEPOINT_NAME_PATTERN = /^[a-zA-Z0-9_]+$/

/**
 * Manages SQLite transactional savepoints and nested rollbacks (Axioms A1, A2, A4).
 *
 * Provides safe nesting, validation against SQL injection, and atomic step rollbacks
 * without locking the entire SQLite database across workflow steps.
 */
export class DatabaseSavepointManager {
  private readonly activeStack: string[] = []

  /**
   * Returns current active savepoint names from innermost to outermost.
   */
  getActiveSavepoints(): readonly string[] {
    return [...this.activeStack]
  }

  /**
   * Returns current nesting depth of active savepoints.
   */
  getDepth(): number {
    return this.activeStack.length
  }

  /**
   * Validates savepoint name against allowed identifier pattern.
   */
  private validateName(name: string): void {
    if (!name || !SAVEPOINT_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid savepoint name: "${name}". Savepoint names must be non-empty and contain only alphanumeric characters and underscores.`,
      )
    }
  }

  /**
   * Creates a new savepoint with the specified name.
   */
  createSavepoint(db: Database.Database, name: string): SavepointReceipt {
    this.validateName(name)

    db.exec(`SAVEPOINT "${name}";`)
    this.activeStack.push(name)

    return {
      savepointName: name,
      action: 'create',
      depth: this.activeStack.length,
      timestamp: Date.now(),
    }
  }

  /**
   * Releases an active savepoint and any nested savepoints created after it.
   */
  releaseSavepoint(db: Database.Database, name: string): SavepointReceipt {
    this.validateName(name)

    const index = this.activeStack.lastIndexOf(name)
    if (index === -1) {
      throw new Error(`Cannot release savepoint "${name}": savepoint is not active in stack.`)
    }

    db.exec(`RELEASE SAVEPOINT "${name}";`)
    // SQLite automatically releases all savepoints created after this one
    this.activeStack.splice(index)

    return {
      savepointName: name,
      action: 'release',
      depth: this.activeStack.length,
      timestamp: Date.now(),
    }
  }

  /**
   * Rolls back changes to the specified savepoint.
   * If releaseAfterRollback is true, the savepoint is also released.
   */
  rollbackToSavepoint(
    db: Database.Database,
    name: string,
    options?: { releaseAfterRollback?: boolean },
  ): SavepointReceipt {
    this.validateName(name)

    const index = this.activeStack.lastIndexOf(name)
    if (index === -1) {
      throw new Error(`Cannot rollback to savepoint "${name}": savepoint is not active in stack.`)
    }

    db.exec(`ROLLBACK TO SAVEPOINT "${name}";`)

    if (options?.releaseAfterRollback) {
      db.exec(`RELEASE SAVEPOINT "${name}";`)
      this.activeStack.splice(index)
    } else {
      // In SQLite, rolling back retains the savepoint itself, but unwinds deeper savepoints
      this.activeStack.splice(index + 1)
    }

    return {
      savepointName: name,
      action: 'rollback',
      depth: this.activeStack.length,
      timestamp: Date.now(),
    }
  }

  /**
   * Executes a synchronous callback within an isolated savepoint.
   * If the callback succeeds, the savepoint is released; on failure, it is rolled back and released.
   */
  withSavepoint<T>(db: Database.Database, name: string, fn: () => T): T {
    this.createSavepoint(db, name)
    try {
      const result = fn()
      this.releaseSavepoint(db, name)
      return result
    } catch (error) {
      try {
        this.rollbackToSavepoint(db, name, { releaseAfterRollback: true })
      } catch {
        // preserve original error
      }
      throw error
    }
  }

  /**
   * Executes an asynchronous callback within an isolated savepoint.
   */
  async withSavepointAsync<T>(
    db: Database.Database,
    name: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.createSavepoint(db, name)
    try {
      const result = await fn()
      this.releaseSavepoint(db, name)
      return result
    } catch (error) {
      try {
        this.rollbackToSavepoint(db, name, { releaseAfterRollback: true })
      } catch {
        // preserve original error
      }
      throw error
    }
  }

  /**
   * Clears in-memory active savepoint stack (e.g. after database disconnect/reset).
   */
  clear(): void {
    this.activeStack.length = 0
  }
}
