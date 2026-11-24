import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { ArtifactId, ArtifactMetadata, RunId } from '@shared/domain'
import type { ArtifactService } from '../artifacts'
import type { ArtifactStore } from '../db/artifactStore'
import { auditArtifactChecksums } from './checksumAudit'

describe('auditArtifactChecksums', () => {
  const runId = 'test-run-1' as RunId
  const content1 = 'Authoritative artifact content 1'
  const hash1 = createHash('sha256').update(content1).digest('hex')
  const content2 = 'Authoritative artifact content 2'
  const hash2 = createHash('sha256').update(content2).digest('hex')

  const meta1: ArtifactMetadata = {
    id: 'art-1' as ArtifactId,
    runId,
    stepId: null,
    relativePath: 'art-1.txt',
    kind: 'prompt-packet',
    name: 'prompt.txt',
    mimeType: 'text/plain',
    sizeBytes: Buffer.byteLength(content1),
    sha256: hash1,
    createdAt: new Date().toISOString(),
  }

  const meta2: ArtifactMetadata = {
    id: 'art-2' as ArtifactId,
    runId,
    stepId: null,
    relativePath: 'art-2.patch',
    kind: 'diff',
    name: 'changes.patch',
    mimeType: 'text/x-diff',
    sizeBytes: Buffer.byteLength(content2),
    sha256: hash2,
    createdAt: new Date().toISOString(),
  }

  it('validates 100% genuine artifacts matching recorded hash and size', async () => {
    const mockStore = {
      listForRun: vi.fn().mockReturnValue([meta1, meta2]),
    } as unknown as ArtifactStore

    const mockService = {
      readArtifact: vi.fn().mockImplementation((id: string) => {
        if (id === 'art-1') return Promise.resolve(Buffer.from(content1))
        if (id === 'art-2') return Promise.resolve(Buffer.from(content2))
        return Promise.reject(new Error('not found'))
      }),
    } as unknown as ArtifactService

    const report = await auditArtifactChecksums(mockService, mockStore, runId)

    expect(report.valid).toBe(true)
    expect(report.totalArtifacts).toBe(2)
    expect(report.verifiedCount).toBe(2)
    expect(report.tamperedCount).toBe(0)
    expect(report.missingCount).toBe(0)
  })

  it('detects tampered content with checksum mismatch and fails closed', async () => {
    const tamperedContent = 'Maliciously altered content'
    const mockStore = {
      listForRun: vi.fn().mockReturnValue([meta1]),
    } as unknown as ArtifactStore

    const mockService = {
      readArtifact: vi.fn().mockResolvedValue(Buffer.from(tamperedContent)),
    } as unknown as ArtifactService

    const report = await auditArtifactChecksums(mockService, mockStore, runId)

    expect(report.valid).toBe(false)
    expect(report.totalArtifacts).toBe(1)
    expect(report.verifiedCount).toBe(0)
    expect(report.tamperedCount).toBe(1)
    expect(report.missingCount).toBe(0)
    expect(report.results[0]?.error).toBe('checksum_mismatch')
    expect(report.results[0]?.recordedHash).toBe(hash1)
    expect(report.results[0]?.computedHash).not.toBe(hash1)
  })

  it('detects missing on-disk artifact files and fails closed', async () => {
    const mockStore = {
      listForRun: vi.fn().mockReturnValue([meta1]),
    } as unknown as ArtifactStore

    const mockService = {
      readArtifact: vi.fn().mockRejectedValue(new Error('ENOENT: no such file or directory')),
    } as unknown as ArtifactService

    const report = await auditArtifactChecksums(mockService, mockStore, runId)

    expect(report.valid).toBe(false)
    expect(report.totalArtifacts).toBe(1)
    expect(report.verifiedCount).toBe(0)
    expect(report.tamperedCount).toBe(0)
    expect(report.missingCount).toBe(1)
    expect(report.results[0]?.error).toBe('file_not_found')
  })

  it('handles empty run gracefully', async () => {
    const mockStore = {
      listForRun: vi.fn().mockReturnValue([]),
    } as unknown as ArtifactStore

    const mockService = {
      readArtifact: vi.fn(),
    } as unknown as ArtifactService

    const report = await auditArtifactChecksums(mockService, mockStore, runId)
    expect(report.valid).toBe(true)
    expect(report.totalArtifacts).toBe(0)
    expect(report.verifiedCount).toBe(0)
  })
})
