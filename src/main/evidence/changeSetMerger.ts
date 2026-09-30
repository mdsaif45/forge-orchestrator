import type { ChangedFile, ChangeSet } from '@shared/domain'

/**
 * Concrete conflict classifications for parallel branch reconciliation.
 *
 * Implements the mathematical disjointness invariants mandated by ADR-007 §3.4 Table 3.4.
 * Every conflict strictly results in HALTED_POLICY: merge-conflict.
 */
export type MergeConflictType =
  | 'modified-modified'
  | 'added-added'
  | 'deleted-deleted'
  | 'modify-delete'
  | 'rename-collision'
  | 'mode-conflict'
  | 'directory-file-collision'
  | 'path-overlap'

export interface MergeConflictDetail {
  readonly type: MergeConflictType
  readonly path: string
  readonly branches: readonly [string, string]
  readonly message: string
}

export interface MergeBranchInput {
  readonly branchId: string
  readonly changeSet: ChangeSet
}

export type ChangeSetMergeResult =
  | {
      readonly ok: true
      readonly mergedFiles: readonly ChangedFile[]
      readonly mergedPatch: string
    }
  | {
      readonly ok: false
      readonly haltCode: 'HALTED_POLICY'
      readonly haltReason: string
      readonly conflicts: readonly MergeConflictDetail[]
    }

/**
 * Normalizes repository-relative paths to POSIX format, removing leading/trailing slashes.
 */
export function normalizePath(rawPath: string): string {
  return rawPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Extracts touched file paths and mode-change paths from unified git patch headers.
 */
function extractPatchInfo(patch: string): {
  readonly touchedPaths: ReadonlySet<string>
  readonly modeChangedPaths: ReadonlySet<string>
} {
  const touchedPaths = new Set<string>()
  const modeChangedPaths = new Set<string>()

  if (!patch.trim()) {
    return { touchedPaths, modeChangedPaths }
  }

  const sections = patch.split(/^diff --git /gm)
  for (const section of sections) {
    if (!section.trim()) continue
    const firstLine = section.split('\n')[0] ?? ''
    const match = /^a\/(.+?)\s+b\/(.+?)$/.exec(firstLine)
    if (match?.[2]) {
      const path = normalizePath(match[2])
      touchedPaths.add(path)
      if (
        section.includes('old mode') ||
        section.includes('new mode') ||
        section.includes('new file mode') ||
        section.includes('deleted file mode')
      ) {
        modeChangedPaths.add(path)
      }
    }
  }

  return { touchedPaths, modeChangedPaths }
}

interface NormalizedBranch {
  readonly branchId: string
  readonly changeSet: ChangeSet
  readonly files: readonly ChangedFile[]
  readonly filesByPath: ReadonlyMap<string, ChangedFile>
  readonly allPaths: ReadonlySet<string>
  readonly renameSources: ReadonlySet<string>
  readonly renameTargets: ReadonlySet<string>
  readonly modeChangedPaths: ReadonlySet<string>
}

function normalizeBranch(input: MergeBranchInput | ChangeSet, index: number): NormalizedBranch {
  const isBranchInput = 'branchId' in input && 'changeSet' in input
  const branchId = isBranchInput ? input.branchId : (input.stepId || `branch-${String(index)}`)
  const changeSet = isBranchInput ? input.changeSet : input

  const filesByPath = new Map<string, ChangedFile>()
  const allPaths = new Set<string>()
  const renameSources = new Set<string>()
  const renameTargets = new Set<string>()

  for (const file of changeSet.files) {
    const normPath = normalizePath(file.path)
    filesByPath.set(normPath, file)
    allPaths.add(normPath)

    if (file.previousPath) {
      const normPrev = normalizePath(file.previousPath)
      allPaths.add(normPrev)
      if (file.changeType === 'renamed') {
        renameSources.add(normPrev)
        renameTargets.add(normPath)
      }
    }
  }

  const patchInfo = extractPatchInfo(changeSet.patch)
  for (const p of patchInfo.touchedPaths) {
    allPaths.add(p)
  }

  return {
    branchId,
    changeSet,
    files: changeSet.files,
    filesByPath,
    allPaths,
    renameSources,
    renameTargets,
    modeChangedPaths: patchInfo.modeChangedPaths,
  }
}

/**
 * Reconciles and merges multiple parallel branch changesets.
 *
 * Mathematically evaluates path disjointness across all touched paths:
 * Conflict <=> Paths(A) ∩ Paths(B) != ∅ OR DirectoryFileCollision(Paths(A), Paths(B)).
 *
 * If ANY collision or intersection occurs, Forge strictly halts with HALTED_POLICY: merge-conflict.
 * Forge NEVER runs a 3-way merge, git merge heuristic, or synthetic LLM resolution to guess conflicting lines (Axiom A2: Never guess).
 */
export function mergeChangeSets(
  branches: readonly (MergeBranchInput | ChangeSet)[],
): ChangeSetMergeResult {
  if (branches.length === 0) {
    return {
      ok: true,
      mergedFiles: [],
      mergedPatch: '',
    }
  }

  const normalized = branches.map((b, idx) => normalizeBranch(b, idx))

  if (normalized.length === 1) {
    const single = normalized[0]
    if (!single) {
      return { ok: true, mergedFiles: [], mergedPatch: '' }
    }
    return {
      ok: true,
      mergedFiles: [...single.files].sort((a, b) =>
        normalizePath(a.path).localeCompare(normalizePath(b.path)),
      ),
      mergedPatch: single.changeSet.patch,
    }
  }

  const conflicts: MergeConflictDetail[] = []

  // Check pairwise disjointness across all branch combinations
  for (let i = 0; i < normalized.length; i++) {
    const branchA = normalized[i]
    if (!branchA) continue

    for (let j = i + 1; j < normalized.length; j++) {
      const branchB = normalized[j]
      if (!branchB) continue

      const checkedPaths = new Set<string>()

      // 1. Direct path intersection audit
      for (const path of branchA.allPaths) {
        if (branchB.allPaths.has(path)) {
          checkedPaths.add(path)
          const fileA = branchA.filesByPath.get(path)
          const fileB = branchB.filesByPath.get(path)

          let conflictType: MergeConflictType = 'path-overlap'
          let detailMessage = `Both branch "${branchA.branchId}" and branch "${branchB.branchId}" modified path "${path}"`

          const isModeConflict =
            branchA.modeChangedPaths.has(path) && branchB.modeChangedPaths.has(path)
          const isRenameConflict =
            branchA.renameSources.has(path) ||
            branchA.renameTargets.has(path) ||
            branchB.renameSources.has(path) ||
            branchB.renameTargets.has(path)

          const isFileADeleted = fileA?.changeType === 'deleted'
          const isFileBDeleted = fileB?.changeType === 'deleted'
          const isFileAModOrAdd = fileA?.changeType === 'modified' || fileA?.changeType === 'added'
          const isFileBModOrAdd = fileB?.changeType === 'modified' || fileB?.changeType === 'added'

          if (isModeConflict) {
            conflictType = 'mode-conflict'
            detailMessage = `Both branch "${branchA.branchId}" and branch "${branchB.branchId}" modified file mode on path "${path}"`
          } else if (isRenameConflict) {
            conflictType = 'rename-collision'
            detailMessage = `Rename collision on path "${path}" between branch "${branchA.branchId}" and branch "${branchB.branchId}"`
          } else if (fileA?.changeType === 'added' && fileB?.changeType === 'added') {
            conflictType = 'added-added'
            detailMessage = `Both branch "${branchA.branchId}" and branch "${branchB.branchId}" added path "${path}"`
          } else if (fileA?.changeType === 'modified' && fileB?.changeType === 'modified') {
            conflictType = 'modified-modified'
            detailMessage = `Both branch "${branchA.branchId}" and branch "${branchB.branchId}" modified path "${path}"`
          } else if (fileA?.changeType === 'deleted' && fileB?.changeType === 'deleted') {
            conflictType = 'deleted-deleted'
            detailMessage = `Both branch "${branchA.branchId}" and branch "${branchB.branchId}" deleted path "${path}"`
          } else if ((isFileADeleted && isFileBModOrAdd) || (isFileBDeleted && isFileAModOrAdd)) {
            conflictType = 'modify-delete'
            const deleter = isFileADeleted ? branchA.branchId : branchB.branchId
            const modifier = isFileADeleted ? branchB.branchId : branchA.branchId
            detailMessage = `Modify/delete collision: branch "${deleter}" deleted path "${path}" while branch "${modifier}" modified/added it`
          }

          conflicts.push({
            type: conflictType,
            path,
            branches: [branchA.branchId, branchB.branchId],
            message: detailMessage,
          })
        }
      }

      // 2. Directory / File collision audit: Path(A) cannot be a directory ancestor of Path(B) and vice-versa
      for (const pathA of branchA.allPaths) {
        for (const pathB of branchB.allPaths) {
          if (pathA === pathB) continue

          if (pathB.startsWith(pathA + '/')) {
            conflicts.push({
              type: 'directory-file-collision',
              path: pathA,
              branches: [branchA.branchId, branchB.branchId],
              message: `Directory/file collision: path "${pathA}" in branch "${branchA.branchId}" conflicts with subpath "${pathB}" in branch "${branchB.branchId}"`,
            })
          } else if (pathA.startsWith(pathB + '/')) {
            conflicts.push({
              type: 'directory-file-collision',
              path: pathB,
              branches: [branchA.branchId, branchB.branchId],
              message: `Directory/file collision: path "${pathB}" in branch "${branchB.branchId}" conflicts with subpath "${pathA}" in branch "${branchA.branchId}"`,
            })
          }
        }
      }
    }
  }

  if (conflicts.length > 0) {
    const summary = conflicts.map((c) => c.message).join('; ')
    return {
      ok: false,
      haltCode: 'HALTED_POLICY',
      haltReason: `HALTED_POLICY: merge-conflict (${summary})`,
      conflicts,
    }
  }

  // All branches are proven disjoint across all mutation categories:
  // Combine files and patches deterministically
  const combinedFiles: ChangedFile[] = []
  for (const b of normalized) {
    combinedFiles.push(...b.files)
  }

  combinedFiles.sort((a, b) => normalizePath(a.path).localeCompare(normalizePath(b.path)))

  const patchParts = normalized.map((b) => b.changeSet.patch.trim()).filter((p) => p.length > 0)

  const mergedPatch = patchParts.join('\n\n')

  return {
    ok: true,
    mergedFiles: combinedFiles,
    mergedPatch,
  }
}
