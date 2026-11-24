import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { runIdSchema, type RunEvent, type RunId } from '@shared/domain'
import type { ArtifactService } from './artifactService'
import type { ArtifactStore } from '../db/artifactStore'
import type { RunStore } from '../db/runStore'

export interface ExportManifestArtifact {
  readonly id: string
  readonly kind: string
  readonly name: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly sha256: string
}

export interface ExportManifest {
  readonly version: string
  readonly runId: string
  readonly exportedAt: string
  readonly run: {
    readonly status: string
    readonly startedAt: string
    readonly finishedAt: string | null
    readonly exitCode: number | null
    readonly summary: string | null
  }
  readonly totalArtifacts: number
  readonly totalEvents: number
  readonly artifacts: readonly ExportManifestArtifact[]
}

export interface RunExportResult {
  readonly valid: boolean
  readonly runId: string
  readonly outputPath: string
  readonly totalArtifacts: number
  readonly totalEvents: number
  readonly manifestSha256: string
  readonly error?: string | undefined
}

/**
 * Exports all physical artifacts, diffs, execution logs, and event records of a run
 * into a self-contained archive bundle with an audit-proof cryptographic manifest.
 *
 * Implements Axioms:
 * - A1 (Truth ownership): Preserves exact immutable event ledger and run metadata.
 * - A3 (Physical evidence): Validates physical on-disk file bytes against recorded SHA-256 hashes.
 */
export async function exportRunArtifactArchive(
  artifactService: ArtifactService,
  artifactStore: ArtifactStore,
  runStore: RunStore,
  rawRunId: string,
  outputPath?: string,
): Promise<RunExportResult> {
  const parsedRunId = runIdSchema.safeParse(rawRunId)
  if (!parsedRunId.success) {
    return {
      valid: false,
      runId: rawRunId,
      outputPath: outputPath ?? '',
      totalArtifacts: 0,
      totalEvents: 0,
      manifestSha256: '',
      error: `Invalid runId format: ${rawRunId}`,
    }
  }

  const runId: RunId = parsedRunId.data
  const run = runStore.getRun(runId)
  if (!run) {
    return {
      valid: false,
      runId,
      outputPath: outputPath ?? '',
      totalArtifacts: 0,
      totalEvents: 0,
      manifestSha256: '',
      error: `Run not found: ${runId}`,
    }
  }

  const resolvedOutPath = resolve(outputPath ?? `forge-export-${runId}.json`)
  const artifacts = artifactStore.listForRun(runId)
  const events: readonly RunEvent[] = runStore.listEventsForRun(runId)

  // Verify and collect artifact manifests
  const manifestArtifacts: ExportManifestArtifact[] = []
  const embeddedArtifacts: {
    id: string
    name: string
    kind: string
    mimeType: string
    contentBase64: string
    sha256: string
  }[] = []

  for (const art of artifacts) {
    let buf: Buffer
    try {
      buf = await artifactService.readArtifact(art.id)
    } catch (err) {
      return {
        valid: false,
        runId,
        outputPath: resolvedOutPath,
        totalArtifacts: artifacts.length,
        totalEvents: events.length,
        manifestSha256: '',
        error: `Physical artifact missing or unreadable (${art.id} - ${art.name}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      }
    }

    const actualHash = createHash('sha256').update(buf).digest('hex')
    if (actualHash !== art.sha256) {
      return {
        valid: false,
        runId,
        outputPath: resolvedOutPath,
        totalArtifacts: artifacts.length,
        totalEvents: events.length,
        manifestSha256: '',
        error: `Cryptographic tamper detected on artifact ${art.id} (${art.name}): recorded ${art.sha256}, actual ${actualHash}`,
      }
    }

    manifestArtifacts.push({
      id: art.id,
      kind: art.kind,
      name: art.name,
      mimeType: art.mimeType,
      sizeBytes: buf.byteLength,
      sha256: actualHash,
    })

    embeddedArtifacts.push({
      id: art.id,
      name: art.name,
      kind: art.kind,
      mimeType: art.mimeType,
      contentBase64: buf.toString('base64'),
      sha256: actualHash,
    })
  }

  const manifest: ExportManifest = {
    version: '1.0.0',
    runId,
    exportedAt: new Date().toISOString(),
    run: {
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      exitCode: run.exitCode,
      summary: run.summary,
    },
    totalArtifacts: manifestArtifacts.length,
    totalEvents: events.length,
    artifacts: manifestArtifacts,
  }

  const manifestJson = JSON.stringify(manifest, null, 2)
  const manifestSha256 = createHash('sha256').update(manifestJson).digest('hex')

  if (resolvedOutPath.endsWith('.json')) {
    // Single self-contained JSON bundle
    const selfContainedBundle = {
      manifest,
      manifestSha256,
      events,
      artifacts: embeddedArtifacts,
    }

    await mkdir(dirname(resolvedOutPath), { recursive: true })
    await writeFile(resolvedOutPath, JSON.stringify(selfContainedBundle, null, 2), 'utf8')
  } else {
    // Directory bundle format
    await mkdir(resolvedOutPath, { recursive: true })
    await writeFile(join(resolvedOutPath, 'manifest.json'), manifestJson, 'utf8')
    await writeFile(
      join(resolvedOutPath, 'events.jsonl'),
      events.map((e: RunEvent) => JSON.stringify(e)).join('\n'),
      'utf8',
    )

    const artsDir = join(resolvedOutPath, 'artifacts')
    await mkdir(artsDir, { recursive: true })

    for (const art of artifacts) {
      const buf = await artifactService.readArtifact(art.id)
      await writeFile(join(artsDir, `${art.id}_${art.name}`), buf)
    }
  }

  return {
    valid: true,
    runId,
    outputPath: resolvedOutPath,
    totalArtifacts: manifestArtifacts.length,
    totalEvents: events.length,
    manifestSha256,
  }
}
