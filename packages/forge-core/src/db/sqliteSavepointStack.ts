/**
 * STATE-019: SQLite Transaction Savepoint Stack & Nested Rollback Manager.
 *
 * Implements a bounded LIFO stack of SQLite savepoint frames for nested transactional
 * rollback isolation, sanitizes identifier tokens, and enforces nesting depth limits.
 */

export interface SavepointFrame {
  name: string
  depth: number
  createdAt: string
  metadata?: Record<string, unknown> | undefined
}

export interface SavepointStackStatus {
  currentDepth: number
  maxDepth: number
  frames: SavepointFrame[]
  topSavepointName?: string | undefined
}

export interface SavepointStackOptions {
  maxDepth?: number | undefined
  namePrefix?: string | undefined
}

const DEFAULT_MAX_DEPTH = 8
const DEFAULT_NAME_PREFIX = 'sp'

/**
 * Sanitizes a savepoint name into a safe SQLite identifier.
 * Rejects illegal characters to prevent SQL injection.
 */
export function sanitizeSavepointName(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('Savepoint name cannot be empty.')
  }

  // SQLite identifiers should only contain alphanumeric characters and underscores
  if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
    throw new Error(
      `Invalid savepoint identifier: "${trimmed}". Must contain only alphanumeric characters and underscores.`,
    )
  }

  return trimmed
}

export class SqliteSavepointStackManager {
  private readonly stack: SavepointFrame[] = []
  private readonly maxDepth: number
  private readonly namePrefix: string
  private counter = 0

  constructor(options: SavepointStackOptions = {}) {
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
    this.namePrefix = options.namePrefix ?? DEFAULT_NAME_PREFIX

    if (this.maxDepth <= 0) {
      throw new Error('maxDepth must be greater than 0.')
    }
  }

  public push(
    customName?: string,
    metadata?: Record<string, unknown>,
  ): { frame: SavepointFrame; sql: string } {
    if (this.stack.length >= this.maxDepth) {
      throw new Error(
        `Maximum savepoint stack depth of ${String(this.maxDepth)} exceeded. Cannot nest deeper savepoint.`,
      )
    }

    this.counter++
    const savepointName = customName
      ? sanitizeSavepointName(customName)
      : `${this.namePrefix}_${String(this.counter)}`

    // Check for duplicate active savepoint name
    if (this.stack.some((f) => f.name === savepointName)) {
      throw new Error(`Savepoint "${savepointName}" is already active in stack.`)
    }

    const frame: SavepointFrame = {
      name: savepointName,
      depth: this.stack.length + 1,
      createdAt: new Date().toISOString(),
      metadata,
    }

    this.stack.push(frame)

    return {
      frame,
      sql: `SAVEPOINT ${savepointName};`,
    }
  }

  public pop(): { frame: SavepointFrame; releaseSql: string } {
    const frame = this.stack.pop()
    if (!frame) {
      throw new Error('Savepoint stack is empty. Nothing to release.')
    }

    return {
      frame,
      releaseSql: `RELEASE ${frame.name};`,
    }
  }

  public rollbackTop(): { frame: SavepointFrame; rollbackSql: string } {
    const frame = this.stack[this.stack.length - 1]
    if (!frame) {
      throw new Error('Savepoint stack is empty. Nothing to rollback.')
    }

    return {
      frame,
      rollbackSql: `ROLLBACK TO ${frame.name};`,
    }
  }

  public rollbackTo(name: string): { unwoundFrames: SavepointFrame[]; rollbackSql: string } {
    const sanitized = sanitizeSavepointName(name)
    const targetIndex = this.stack.findIndex((f) => f.name === sanitized)

    if (targetIndex === -1) {
      throw new Error(`Savepoint "${sanitized}" not found in active stack.`)
    }

    // Unwind frames above targetIndex
    const unwoundFrames = this.stack.splice(targetIndex + 1)

    return {
      unwoundFrames,
      rollbackSql: `ROLLBACK TO ${sanitized};`,
    }
  }

  public releaseTo(name: string): { releasedFrames: SavepointFrame[]; releaseSql: string } {
    const sanitized = sanitizeSavepointName(name)
    const targetIndex = this.stack.findIndex((f) => f.name === sanitized)

    if (targetIndex === -1) {
      throw new Error(`Savepoint "${sanitized}" not found in active stack.`)
    }

    // Unwind target and all frames above it
    const releasedFrames = this.stack.splice(targetIndex)

    return {
      releasedFrames,
      releaseSql: `RELEASE ${sanitized};`,
    }
  }

  public rollbackAll(): { unwoundFrames: SavepointFrame[]; rollbackSqlStatements: string[] } {
    if (this.stack.length === 0) {
      return { unwoundFrames: [], rollbackSqlStatements: [] }
    }

    const baseFrame = this.stack[0]
    const unwoundFrames = [...this.stack]
    this.stack.length = 0

    return {
      unwoundFrames,
      rollbackSqlStatements: baseFrame
        ? [`ROLLBACK TO ${baseFrame.name};`, `RELEASE ${baseFrame.name};`]
        : [],
    }
  }

  public getStatus(): SavepointStackStatus {
    const topFrame = this.stack[this.stack.length - 1]
    return {
      currentDepth: this.stack.length,
      maxDepth: this.maxDepth,
      frames: [...this.stack],
      topSavepointName: topFrame?.name,
    }
  }
}
