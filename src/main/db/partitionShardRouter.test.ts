import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  auditShardRegistry,
  computeShardFileName,
  resolveShardPath,
  sanitizeProjectId,
} from './partitionShardRouter'

describe('partitionShardRouter (STATE-018)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shard-test-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('sanitizes valid project IDs and rejects path traversal attempts', () => {
    expect(sanitizeProjectId('my-project-123')).toBe('my-project-123')
    expect(sanitizeProjectId('project:with:colons')).toBe('project_with_colons')

    expect(() => sanitizeProjectId('')).toThrow('Project ID cannot be empty')
    expect(() => sanitizeProjectId('../etc/passwd')).toThrow('forbidden path traversal')
    expect(() => sanitizeProjectId('foo/bar')).toThrow('forbidden path traversal')
    expect(() => sanitizeProjectId('foo\\bar')).toThrow('forbidden path traversal')
  })

  it('computes deterministic shard file names with hash prefix', () => {
    const { shardId, fileName } = computeShardFileName('repo-alpha')
    expect(fileName.endsWith('.sqlite')).toBe(true)
    expect(shardId.startsWith('shard_')).toBe(true)
    expect(shardId).toContain('repo-alpha')

    // Deterministic check
    const second = computeShardFileName('repo-alpha')
    expect(second.fileName).toBe(fileName)
  })

  it('resolves sandboxed shard paths inside dataDir/shards', () => {
    const routing = resolveShardPath('proj-test', tempDir)

    expect(routing.projectId).toBe('proj-test')
    expect(routing.isSandboxed).toBe(true)
    expect(routing.resolvedPath.startsWith(path.join(tempDir, 'shards'))).toBe(true)
    expect(routing.exists).toBe(false)
  })

  it('audits existing shards in the registry correctly', () => {
    const shardsDir = path.join(tempDir, 'shards')
    fs.mkdirSync(shardsDir, { recursive: true })

    const routingA = resolveShardPath('projectA', tempDir)
    fs.writeFileSync(routingA.resolvedPath, 'fake-sqlite-binary-data')

    const routingB = resolveShardPath('projectB', tempDir)
    fs.writeFileSync(routingB.resolvedPath, 'fake-sqlite-binary-data-2')

    const registry = auditShardRegistry(tempDir)
    expect(registry.shardsCount).toBe(2)
    expect(registry.shards.map((s) => s.projectId)).toContain('projectA')
    expect(registry.shards.map((s) => s.projectId)).toContain('projectB')
  })
})
