/**
 * STATE-018: SQLite Multi-Tenant Database Partitioning & Shard Router.
 *
 * Deterministically maps project identifiers to isolated SQLite database shard files
 * while enforcing filesystem directory boundary containment, preventing path traversal attacks,
 * and managing shard health auditing.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export interface ShardRoutingInfo {
  projectId: string
  shardId: string
  shardFileName: string
  resolvedPath: string
  isSandboxed: boolean
  exists: boolean
  createdAt?: string | undefined
}

export interface ShardRegistryReport {
  dataDir: string
  shardsDirectory: string
  shardsCount: number
  shards: ShardRoutingInfo[]
}

export interface ShardRouterOptions {
  dataDir?: string
}

const DEFAULT_SHARDS_SUBDIR = 'shards'

/**
 * Sanitizes a project identifier into a safe alphanumeric shard token.
 * Rejects path traversal attempts.
 */
export function sanitizeProjectId(projectId: string): string {
  const trimmed = projectId.trim()
  if (!trimmed) {
    throw new Error('Project ID cannot be empty.')
  }

  if (
    trimmed.includes('..') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0')
  ) {
    throw new Error(
      `Invalid project ID contains forbidden path traversal characters: "${projectId}".`,
    )
  }

  // Allow only alphanumeric, dash, underscore
  const sanitized = trimmed.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!sanitized) {
    throw new Error(`Project ID resulted in empty token after sanitization: "${projectId}".`)
  }
  return sanitized
}

/**
 * Computes deterministic shard filename from project ID.
 */
export function computeShardFileName(projectId: string): { shardId: string; fileName: string } {
  const cleanId = sanitizeProjectId(projectId)
  const hash = crypto.createHash('sha256').update(projectId).digest('hex').slice(0, 8)
  const shardId = `shard_${hash}_${cleanId}`
  const fileName = `${shardId}.sqlite`
  return { shardId, fileName }
}

/**
 * Resolves and validates shard path within the sandboxed shards directory.
 * Fails closed if resolved path escapes the intended directory (A1, A7).
 */
export function resolveShardPath(projectId: string, dataDir: string): ShardRoutingInfo {
  const resolvedDataDir = path.resolve(dataDir)
  const shardsDir = path.resolve(resolvedDataDir, DEFAULT_SHARDS_SUBDIR)

  const { shardId, fileName } = computeShardFileName(projectId)
  const resolvedPath = path.resolve(shardsDir, fileName)

  // Sandboxing verification: Ensure resolved path strictly resides within shardsDir
  const relative = path.relative(shardsDir, resolvedPath)
  const isSandboxed = !relative.startsWith('..') && !path.isAbsolute(relative)

  if (!isSandboxed) {
    throw new Error(
      `Sandbox violation: Shard path "${resolvedPath}" escapes designated shards directory "${shardsDir}".`,
    )
  }

  let exists = false
  let createdAt: string | undefined

  try {
    if (fs.existsSync(resolvedPath)) {
      exists = true
      const stat = fs.statSync(resolvedPath)
      createdAt = stat.birthtime.toISOString()
    }
  } catch {
    // Ignore stat failures on uninitialized paths
  }

  return {
    projectId,
    shardId,
    shardFileName: fileName,
    resolvedPath,
    isSandboxed,
    exists,
    createdAt,
  }
}

/**
 * Discovers and audits existing shard database files within dataDir/shards.
 */
export function auditShardRegistry(dataDir: string): ShardRegistryReport {
  const resolvedDataDir = path.resolve(dataDir)
  const shardsDirectory = path.resolve(resolvedDataDir, DEFAULT_SHARDS_SUBDIR)

  if (!fs.existsSync(shardsDirectory)) {
    return {
      dataDir: resolvedDataDir,
      shardsDirectory,
      shardsCount: 0,
      shards: [],
    }
  }

  const entries = fs.readdirSync(shardsDirectory)
  const shards: ShardRoutingInfo[] = []

  for (const entry of entries) {
    if (entry.endsWith('.sqlite')) {
      const fullPath = path.resolve(shardsDirectory, entry)
      const shardName = entry.replace(/\.sqlite$/, '')
      const parts = shardName.split('_')
      // Format: shard_<hash>_<projectId>
      const projectId = parts.length >= 3 ? parts.slice(2).join('_') : shardName

      let createdAt: string | undefined
      try {
        const stat = fs.statSync(fullPath)
        createdAt = stat.birthtime.toISOString()
      } catch {
        // Ignore stat failure
      }

      shards.push({
        projectId,
        shardId: shardName,
        shardFileName: entry,
        resolvedPath: fullPath,
        isSandboxed: true,
        exists: true,
        createdAt,
      })
    }
  }

  return {
    dataDir: resolvedDataDir,
    shardsDirectory,
    shardsCount: shards.length,
    shards,
  }
}
