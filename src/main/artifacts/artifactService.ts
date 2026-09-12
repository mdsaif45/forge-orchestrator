import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  artifactIdSchema,
  type ArtifactId,
  type ArtifactKind,
  type ArtifactMetadata,
  type RunId,
  type StepId,
} from '@shared/domain'
import type { ArtifactStore } from '../db/artifactStore'

export interface WriteArtifactOptions {
  readonly runId: RunId
  readonly stepId?: StepId | null
  readonly kind: ArtifactKind
  readonly name: string
  readonly content: string | Buffer | Uint8Array
  readonly mimeType?: string
  readonly createdAt?: string
  readonly id?: ArtifactId
}

export interface ReadWindowResult {
  readonly data: Buffer
  readonly totalBytes: number
}

function sanitizeFileName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '_')
  return sanitized.length > 0 ? sanitized : 'artifact.bin'
}

/**
 * Filesystem storage and metadata manager for run artifacts.
 *
 * Enforces Axiom A1 (single source of truth) & Axiom A3 (physical evidence beats claims):
 * Raw bytes reside on disk under `<artifactsDir>/<run-id>/<artifact-id>-<safe-name>`,
 * while structured metadata and SHA-256 hashes reside in SQLite.
 */
export class ArtifactService {
  constructor(
    private readonly baseDir: string,
    private readonly store: ArtifactStore,
  ) {}

  /**
   * Resolves the absolute path on disk for a given relative path or metadata.
   */
  resolvePath(relativePathOrMetadata: string | ArtifactMetadata): string {
    const rel =
      typeof relativePathOrMetadata === 'string'
        ? relativePathOrMetadata
        : relativePathOrMetadata.relativePath
    return resolve(this.baseDir, ...rel.split('/'))
  }

  /**
   * Writes artifact content to disk and records metadata in SQLite.
   */
  async writeArtifact(options: WriteArtifactOptions): Promise<ArtifactMetadata> {
    const id = options.id ?? artifactIdSchema.parse(randomUUID())
    const contentBuffer = Buffer.isBuffer(options.content)
      ? options.content
      : typeof options.content === 'string'
        ? Buffer.from(options.content, 'utf-8')
        : Buffer.from(options.content)

    const sha256 = createHash('sha256').update(contentBuffer).digest('hex')
    const sizeBytes = contentBuffer.length
    const safeName = sanitizeFileName(options.name)
    const fileName = `${id}-${safeName}`
    const relativePath = `${options.runId}/${fileName}`
    const createdAt = options.createdAt ?? new Date().toISOString()
    const mimeType =
      options.mimeType ??
      (typeof options.content === 'string'
        ? 'text/plain; charset=utf-8'
        : 'application/octet-stream')

    const runDir = join(this.baseDir, options.runId)
    await mkdir(runDir, { recursive: true })

    const absolutePath = join(runDir, fileName)
    await writeFile(absolutePath, contentBuffer)

    const metadata: ArtifactMetadata = {
      id,
      runId: options.runId,
      stepId: options.stepId ?? null,
      kind: options.kind,
      name: options.name,
      mimeType,
      sizeBytes,
      sha256,
      relativePath,
      createdAt,
    }

    return this.store.record(metadata)
  }

  /**
   * Retrieves artifact metadata by ID.
   */
  getMetadata(id: ArtifactId): ArtifactMetadata | null {
    return this.store.get(id)
  }

  /**
   * Reads the full binary content of an artifact from disk.
   */
  async readArtifact(id: ArtifactId): Promise<Buffer> {
    const meta = this.getMetadata(id)
    if (!meta) {
      throw new Error(`Artifact ${id} not found`)
    }

    const filePath = this.resolvePath(meta)
    return readFile(filePath)
  }

  /**
   * Reads an artifact's content as a decoded text string.
   */
  async readArtifactText(id: ArtifactId, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    const buf = await this.readArtifact(id)
    return buf.toString(encoding)
  }

  /**
   * Reads a slice/window of an artifact without loading the full file into memory.
   * Useful for large logs, diffs, and chunked streaming.
   */
  async readWindow(
    id: ArtifactId,
    offsetBytes: number,
    lengthBytes: number,
  ): Promise<ReadWindowResult> {
    const meta = this.getMetadata(id)
    if (!meta) {
      throw new Error(`Artifact ${id} not found`)
    }

    const filePath = this.resolvePath(meta)
    const totalBytes = meta.sizeBytes

    if (offsetBytes < 0) {
      throw new Error(`Invalid offsetBytes: ${String(offsetBytes)}`)
    }

    if (offsetBytes >= totalBytes || lengthBytes <= 0) {
      return { data: Buffer.alloc(0), totalBytes }
    }

    const toRead = Math.min(lengthBytes, totalBytes - offsetBytes)
    const buffer = Buffer.alloc(toRead)

    const handle = await open(filePath, 'r')
    try {
      await handle.read(buffer, 0, toRead, offsetBytes)
      return { data: buffer, totalBytes }
    } finally {
      await handle.close()
    }
  }

  /**
   * Lists all artifacts for a run.
   */
  listArtifacts(runId: RunId): readonly ArtifactMetadata[] {
    return this.store.listForRun(runId)
  }

  /**
   * Lists all artifacts for a specific step.
   */
  listForStep(stepId: StepId): readonly ArtifactMetadata[] {
    return this.store.listForStep(stepId)
  }
}
