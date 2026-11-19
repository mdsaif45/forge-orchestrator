import { runIdSchema } from '@shared/domain'
import type { ArtifactService } from '../artifacts'
import type { ArtifactStore } from '../db/artifactStore'

export interface DiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly header: string
  readonly lines: readonly string[]
}

export interface FileDiff {
  readonly oldPath: string
  readonly newPath: string
  readonly hunks: readonly DiffHunk[]
  readonly isBinary: boolean
}

export interface FileConflict {
  readonly filePath: string
  readonly type: 'hunk-collision' | 'binary-collision' | 'deletion-collision'
  readonly details: string
  readonly collidingHunks?:
    | readonly {
        readonly hunkA: string
        readonly hunkB: string
      }[]
    | undefined
}

export interface ChangesetConflictReport {
  readonly valid: boolean
  readonly hasConflicts: boolean
  readonly totalFilesA: number
  readonly totalFilesB: number
  readonly overlappingFiles: readonly string[]
  readonly conflicts: readonly FileConflict[]
  readonly formattedSummary: string
}

export interface ChangesetMergeResult {
  readonly success: boolean
  readonly mergedPatch: string | null
  readonly conflictReport: ChangesetConflictReport
  readonly formattedSummary: string
}

/**
 * Parses unified diff text into structured file diffs and hunks.
 */
export function parseUnifiedDiff(diffText: string): FileDiff[] {
  const fileDiffs: FileDiff[] = []
  const lines = diffText.split(/\r?\n/)
  let currentFile: {
    oldPath: string
    newPath: string
    hunks: DiffHunk[]
    isBinary: boolean
  } | null = null
  let currentHunk: {
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    header: string
    lines: string[]
  } | null = null

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (currentHunk && currentFile) {
        currentFile.hunks.push(currentHunk)
        currentHunk = null
      }
      if (currentFile) {
        fileDiffs.push(currentFile)
      }
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      currentFile = {
        oldPath: match?.[1] ?? 'unknown',
        newPath: match?.[2] ?? 'unknown',
        hunks: [],
        isBinary: false,
      }
      continue
    }

    if (!currentFile) continue

    if (line.startsWith('Binary files ') || line.includes('GIT binary patch')) {
      currentFile.isBinary = true
      continue
    }

    if (line.startsWith('--- a/')) {
      currentFile.oldPath = line.slice(6)
      continue
    }

    if (line.startsWith('+++ b/')) {
      currentFile.newPath = line.slice(6)
      continue
    }

    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunkMatch) {
      if (currentHunk) {
        currentFile.hunks.push(currentHunk)
      }
      const oldStart = parseInt(hunkMatch[1] ?? '1', 10)
      const oldLines = parseInt(hunkMatch[2] ?? '1', 10)
      const newStart = parseInt(hunkMatch[3] ?? '1', 10)
      const newLines = parseInt(hunkMatch[4] ?? '1', 10)
      currentHunk = {
        oldStart,
        oldLines,
        newStart,
        newLines,
        header: line,
        lines: [line],
      }
      continue
    }

    if (currentHunk) {
      currentHunk.lines.push(line)
    }
  }

  if (currentHunk && currentFile) {
    currentFile.hunks.push(currentHunk)
  }
  if (currentFile) {
    fileDiffs.push(currentFile)
  }

  return fileDiffs
}

/**
 * Checks whether two hunk line ranges overlap in the original file.
 */
function hunksOverlap(hunkA: DiffHunk, hunkB: DiffHunk): boolean {
  const aStart = hunkA.oldStart
  const aEnd = hunkA.oldStart + Math.max(hunkA.oldLines, 1) - 1
  const bStart = hunkB.oldStart
  const bEnd = hunkB.oldStart + Math.max(hunkB.oldLines, 1) - 1

  return Math.max(aStart, bStart) <= Math.min(aEnd, bEnd)
}

/**
 * Detects conflicts between two unified diff changesets (Axioms A2, A3).
 */
export function detectChangesetConflicts(diffA: string, diffB: string): ChangesetConflictReport {
  const filesA = parseUnifiedDiff(diffA)
  const filesB = parseUnifiedDiff(diffB)

  const mapA = new Map(filesA.map((f) => [f.newPath, f]))
  const mapB = new Map(filesB.map((f) => [f.newPath, f]))

  const overlappingFiles: string[] = []
  const conflicts: FileConflict[] = []

  for (const [filePath, fileA] of mapA) {
    const fileB = mapB.get(filePath)
    if (!fileB) continue

    overlappingFiles.push(filePath)

    if (fileA.isBinary || fileB.isBinary) {
      conflicts.push({
        filePath,
        type: 'binary-collision',
        details: `Both changesets modify binary file "${filePath}". Binary three-way merges are not supported.`,
      })
      continue
    }

    // Check hunk overlaps
    const collidingHunks: { hunkA: string; hunkB: string }[] = []
    for (const hA of fileA.hunks) {
      for (const hB of fileB.hunks) {
        if (hunksOverlap(hA, hB)) {
          collidingHunks.push({
            hunkA: hA.header,
            hunkB: hB.header,
          })
        }
      }
    }

    if (collidingHunks.length > 0) {
      conflicts.push({
        filePath,
        type: 'hunk-collision',
        details: `${String(collidingHunks.length)} hunk collision(s) detected in "${filePath}".`,
        collidingHunks,
      })
    }
  }

  const hasConflicts = conflicts.length > 0
  const lines: string[] = []
  lines.push('================================================================================')
  lines.push('CHANGESET CONFLICT AUDIT REPORT')
  lines.push('================================================================================')
  lines.push(`  Changeset A Files:     ${String(filesA.length)}`)
  lines.push(`  Changeset B Files:     ${String(filesB.length)}`)
  lines.push(`  Overlapping Files:     ${String(overlappingFiles.length)}`)
  lines.push(
    `  Conflict Status:       ${hasConflicts ? 'CONFLICTS DETECTED' : 'CLEAN / MERGEABLE'}`,
  )
  lines.push('================================================================================')

  if (hasConflicts) {
    lines.push('Colliding Files & Hunks:')
    for (const c of conflicts) {
      lines.push(`  ✖ ${c.filePath} (${c.type}): ${c.details}`)
      if (c.collidingHunks) {
        for (const ch of c.collidingHunks) {
          lines.push(`      Hunk A: ${ch.hunkA}`)
          lines.push(`      Hunk B: ${ch.hunkB}`)
        }
      }
    }
  } else {
    lines.push('  ✓ No overlapping hunk collisions detected. Changesets can be merged cleanly.')
  }

  return {
    valid: true,
    hasConflicts,
    totalFilesA: filesA.length,
    totalFilesB: filesB.length,
    overlappingFiles,
    conflicts,
    formattedSummary: lines.join('\n'),
  }
}

/**
 * Synthesizes a merged patch from two disjoint changesets or fails closed if conflicts exist (Axiom A2).
 */
export function mergeChangesetDiffs(diffA: string, diffB: string): ChangesetMergeResult {
  const report = detectChangesetConflicts(diffA, diffB)
  if (report.hasConflicts) {
    return {
      success: false,
      mergedPatch: null,
      conflictReport: report,
      formattedSummary: `Merge aborted: ${String(report.conflicts.length)} conflicting file(s) detected.\n\n${report.formattedSummary}`,
    }
  }

  // Combine patches cleanly
  const trimmedA = diffA.trim()
  const trimmedB = diffB.trim()
  const merged =
    trimmedA && trimmedB
      ? `${trimmedA}\n\n${trimmedB}\n`
      : trimmedA || trimmedB
        ? `${trimmedA || trimmedB}\n`
        : ''

  return {
    success: true,
    mergedPatch: merged,
    conflictReport: report,
    formattedSummary: `✓ Clean three-way patch synthesis complete (${String(report.totalFilesA + report.totalFilesB - report.overlappingFiles.length)} total unique files).\n\n${report.formattedSummary}`,
  }
}

/**
 * Audits and compares changeset artifacts between two runs in the artifact store.
 */
export async function auditRunChangesetConflicts(
  artifacts: ArtifactService,
  artifactStore: ArtifactStore,
  runIdA: string,
  runIdB: string,
): Promise<ChangesetConflictReport> {
  const getRunDiffText = async (runId: string): Promise<string> => {
    const parsedRunId = runIdSchema.parse(runId)
    const list = artifactStore.listForRun(parsedRunId)
    const diffArtifacts = list.filter((a) => a.kind === 'changeset' || a.kind === 'diff')
    if (diffArtifacts.length === 0) return ''
    const chunks: string[] = []
    for (const a of diffArtifacts) {
      try {
        const text = await artifacts.readArtifactText(a.id)
        chunks.push(text)
      } catch {
        // Skip unreadable
      }
    }
    return chunks.join('\n')
  }

  const [diffA, diffB] = await Promise.all([getRunDiffText(runIdA), getRunDiffText(runIdB)])
  return detectChangesetConflicts(diffA, diffB)
}
