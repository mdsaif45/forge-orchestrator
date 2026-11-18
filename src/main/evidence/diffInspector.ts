import { type ArtifactMetadata, runIdSchema } from '@shared/domain'
import type { ArtifactService } from '../artifacts'
import type { ArtifactStore } from '../db/artifactStore'

export interface FileDiffStat {
  readonly path: string
  readonly status: 'added' | 'modified' | 'deleted'
  readonly additions: number
  readonly deletions: number
  readonly isBinary: boolean
}

export interface RunDiffReport {
  readonly valid: boolean
  readonly runId: string
  readonly stepId?: string | undefined
  readonly artifactId?: string | undefined
  readonly totalFiles: number
  readonly totalAdditions: number
  readonly totalDeletions: number
  readonly files: readonly FileDiffStat[]
  readonly rawPatch: string
  readonly scopeBreaches?: readonly string[] | undefined
  readonly error?: string | undefined
}

export interface InspectRunDiffOptions {
  readonly stepId?: string | undefined
  readonly allowedPaths?: readonly string[] | undefined
}

/**
 * Parses raw unified git diff text into structured file-level metrics and statistics.
 */
export function parseUnifiedDiff(rawPatch: string): {
  readonly files: readonly FileDiffStat[]
  readonly totalAdditions: number
  readonly totalDeletions: number
} {
  const lines = rawPatch.split('\n')
  const files: FileDiffStat[] = []

  let currentPath: string | null = null
  let currentStatus: 'added' | 'modified' | 'deleted' = 'modified'
  let currentAdditions = 0
  let currentDeletions = 0
  let isBinary = false

  function flushCurrent(): void {
    if (currentPath) {
      files.push({
        path: currentPath,
        status: currentStatus,
        additions: currentAdditions,
        deletions: currentDeletions,
        isBinary,
      })
    }
    currentPath = null
    currentStatus = 'modified'
    currentAdditions = 0
    currentDeletions = 0
    isBinary = false
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushCurrent()
      // e.g. diff --git a/src/index.ts b/src/index.ts
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      if (match?.[2]) {
        currentPath = match[2]
      } else {
        const parts = line.split(' ')
        currentPath = (parts[parts.length - 1] ?? '').replace(/^[ab]\//, '')
      }
    } else if (line.startsWith('new file mode ')) {
      currentStatus = 'added'
    } else if (line.startsWith('deleted file mode ')) {
      currentStatus = 'deleted'
    } else if (line.startsWith('Binary files ') && line.includes('differ')) {
      isBinary = true
    } else if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      // Header markers; do not count as added/deleted lines
      continue
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      currentAdditions++
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      currentDeletions++
    }
  }

  flushCurrent()

  let totalAdditions = 0
  let totalDeletions = 0
  for (const file of files) {
    totalAdditions += file.additions
    totalDeletions += file.deletions
  }

  return {
    files,
    totalAdditions,
    totalDeletions,
  }
}

/**
 * Inspects physical changeset and diff artifacts recorded for a run or step,
 * calculating file modifications, additions, deletions, and scope compliance (Axioms A3, A7).
 */
export async function inspectRunDiff(
  artifactService: ArtifactService,
  artifactStore: ArtifactStore,
  runId: string,
  options?: InspectRunDiffOptions,
): Promise<RunDiffReport> {
  const parsedRunId = runIdSchema.parse(runId)
  const artifacts: readonly ArtifactMetadata[] = artifactStore.listForRun(parsedRunId)
  if (artifacts.length === 0) {
    return {
      valid: false,
      runId,
      stepId: options?.stepId,
      totalFiles: 0,
      totalAdditions: 0,
      totalDeletions: 0,
      files: [],
      rawPatch: '',
      error: `No artifacts found for run: ${runId}`,
    }
  }

  // Filter by step if provided
  let filtered: readonly ArtifactMetadata[] = artifacts
  if (options?.stepId) {
    filtered = filtered.filter((a: ArtifactMetadata) => a.stepId === options.stepId)
  }

  // Find authoritative changeset or diff artifact
  const diffArtifact: ArtifactMetadata | undefined =
    filtered.find((a: ArtifactMetadata) => a.kind === 'changeset' || a.kind === 'diff') ??
    artifacts.find((a: ArtifactMetadata) => a.kind === 'changeset' || a.kind === 'diff')

  if (!diffArtifact) {
    return {
      valid: false,
      runId,
      stepId: options?.stepId,
      totalFiles: 0,
      totalAdditions: 0,
      totalDeletions: 0,
      files: [],
      rawPatch: '',
      error: `No changeset or diff artifact found for run ${runId}${options?.stepId ? ` (step ${options.stepId})` : ''}`,
    }
  }

  const rawPatch = await artifactService.readArtifactText(diffArtifact.id)
  const { files, totalAdditions, totalDeletions } = parseUnifiedDiff(rawPatch)

  // Verify change scope if allowedPaths specified (Axiom A7)
  let scopeBreaches: string[] | undefined
  if (options?.allowedPaths && options.allowedPaths.length > 0) {
    const allowed = new Set(options.allowedPaths)
    const breaches = files
      .map((f) => f.path)
      .filter(
        (p) => !allowed.has(p) && !options.allowedPaths?.some((prefix) => p.startsWith(prefix)),
      )
    if (breaches.length > 0) {
      scopeBreaches = breaches
    }
  }

  return {
    valid: true,
    runId,
    stepId: diffArtifact.stepId ?? options?.stepId ?? undefined,
    artifactId: diffArtifact.id,
    totalFiles: files.length,
    totalAdditions,
    totalDeletions,
    files,
    rawPatch,
    scopeBreaches,
  }
}
