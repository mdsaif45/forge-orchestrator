/**
 * Changeset hunk conflict resolution three-way merge synthesizer.
 *
 * Implements line-level three-way merge arbitration between ancestor base,
 * current branch (ours), and incoming branch (theirs), auto-merging non-overlapping
 * modifications and formatting standard conflict markers (A1, A3).
 */

export type ChunkMergeStatus =
  'CLEAN_BASE' | 'CLEAN_OURS' | 'CLEAN_THEIRS' | 'CLEAN_BOTH_SAME' | 'CONFLICT'

export interface MergedChunk {
  readonly status: ChunkMergeStatus
  readonly baseLines: readonly string[]
  readonly oursLines: readonly string[]
  readonly theirsLines: readonly string[]
  readonly mergedLines: readonly string[]
}

export interface ThreeWayMergeReport {
  readonly hasConflicts: boolean
  readonly conflictsCount: number
  readonly cleanChunksCount: number
  readonly totalChunksCount: number
  readonly mergedContent: string
  readonly chunks: readonly MergedChunk[]
}

export interface ThreeWayMergeOptions {
  /** Label marker for ours branch (defaults to 'ours'). */
  readonly oursLabel?: string | undefined
  /** Label marker for theirs branch (defaults to 'theirs'). */
  readonly theirsLabel?: string | undefined
}

export class ChangesetThreeWayMergeSynthesizer {
  /**
   * Performs three-way line-level merge among base, ours, and theirs buffers.
   */
  merge(
    baseContent: string,
    oursContent: string,
    theirsContent: string,
    options: ThreeWayMergeOptions = {},
  ): ThreeWayMergeReport {
    const oursLabel = options.oursLabel ?? 'ours'
    const theirsLabel = options.theirsLabel ?? 'theirs'

    const baseLines = this.splitLines(baseContent)
    const oursLines = this.splitLines(oursContent)
    const theirsLines = this.splitLines(theirsContent)

    // Fast path: All identical
    if (oursContent === theirsContent) {
      const status: ChunkMergeStatus =
        oursContent === baseContent ? 'CLEAN_BASE' : 'CLEAN_BOTH_SAME'
      const chunk: MergedChunk = {
        status,
        baseLines,
        oursLines,
        theirsLines,
        mergedLines: oursLines,
      }
      return {
        hasConflicts: false,
        conflictsCount: 0,
        cleanChunksCount: 1,
        totalChunksCount: 1,
        mergedContent: oursContent,
        chunks: [chunk],
      }
    }

    // Fast path: Only ours modified base
    if (theirsContent === baseContent) {
      const chunk: MergedChunk = {
        status: 'CLEAN_OURS',
        baseLines,
        oursLines,
        theirsLines,
        mergedLines: oursLines,
      }
      return {
        hasConflicts: false,
        conflictsCount: 0,
        cleanChunksCount: 1,
        totalChunksCount: 1,
        mergedContent: oursContent,
        chunks: [chunk],
      }
    }

    // Fast path: Only theirs modified base
    if (oursContent === baseContent) {
      const chunk: MergedChunk = {
        status: 'CLEAN_THEIRS',
        baseLines,
        oursLines,
        theirsLines,
        mergedLines: theirsLines,
      }
      return {
        hasConflicts: false,
        conflictsCount: 0,
        cleanChunksCount: 1,
        totalChunksCount: 1,
        mergedContent: theirsContent,
        chunks: [chunk],
      }
    }

    // Line-by-line three-way alignment
    const chunks = this.synthesizeChunks(baseLines, oursLines, theirsLines, oursLabel, theirsLabel)
    const allMergedLines = chunks.flatMap((c) => c.mergedLines)
    const mergedContent = allMergedLines.join('\n')

    let conflictsCount = 0
    let cleanChunksCount = 0

    for (const c of chunks) {
      if (c.status === 'CONFLICT') {
        conflictsCount += 1
      } else {
        cleanChunksCount += 1
      }
    }

    return {
      hasConflicts: conflictsCount > 0,
      conflictsCount,
      cleanChunksCount,
      totalChunksCount: chunks.length,
      mergedContent,
      chunks,
    }
  }

  private splitLines(content: string): string[] {
    if (content.length === 0) return []
    const lines = content.split(/\r?\n/)
    return lines
  }

  private synthesizeChunks(
    base: string[],
    ours: string[],
    theirs: string[],
    oursLabel: string,
    theirsLabel: string,
  ): MergedChunk[] {
    const chunks: MergedChunk[] = []
    let bIdx = 0
    let oIdx = 0
    let tIdx = 0

    while (bIdx < base.length || oIdx < ours.length || tIdx < theirs.length) {
      const bLine = bIdx < base.length ? base[bIdx] : undefined
      const oLine = oIdx < ours.length ? ours[oIdx] : undefined
      const tLine = tIdx < theirs.length ? theirs[tIdx] : undefined

      // Case 1: All three lines match
      if (
        bLine !== undefined &&
        oLine !== undefined &&
        tLine !== undefined &&
        bLine === oLine &&
        bLine === tLine
      ) {
        chunks.push({
          status: 'CLEAN_BASE',
          baseLines: [bLine],
          oursLines: [oLine],
          theirsLines: [tLine],
          mergedLines: [bLine],
        })
        bIdx += 1
        oIdx += 1
        tIdx += 1
        continue
      }

      // Case 2: Ours and theirs both made identical modification
      if (oLine !== undefined && tLine !== undefined && oLine === tLine && oLine !== bLine) {
        const baseChunk = bLine !== undefined ? [bLine] : []
        chunks.push({
          status: 'CLEAN_BOTH_SAME',
          baseLines: baseChunk,
          oursLines: [oLine],
          theirsLines: [tLine],
          mergedLines: [oLine],
        })
        if (bLine !== undefined) bIdx += 1
        oIdx += 1
        tIdx += 1
        continue
      }

      // Case 3: Only ours changed (theirs still matches base)
      if (bLine !== undefined && tLine !== undefined && bLine === tLine && oLine !== bLine) {
        chunks.push({
          status: 'CLEAN_OURS',
          baseLines: [bLine],
          oursLines: oLine !== undefined ? [oLine] : [],
          theirsLines: [tLine],
          mergedLines: oLine !== undefined ? [oLine] : [],
        })
        bIdx += 1
        if (oLine !== undefined) oIdx += 1
        tIdx += 1
        continue
      }

      // Case 4: Only theirs changed (ours still matches base)
      if (bLine !== undefined && oLine !== undefined && bLine === oLine && tLine !== bLine) {
        chunks.push({
          status: 'CLEAN_THEIRS',
          baseLines: [bLine],
          oursLines: [oLine],
          theirsLines: tLine !== undefined ? [tLine] : [],
          mergedLines: tLine !== undefined ? [tLine] : [],
        })
        bIdx += 1
        oIdx += 1
        if (tLine !== undefined) tIdx += 1
        continue
      }

      // Case 5: Genuine Conflict (both changed to different things)
      const conflictBase: string[] = bLine !== undefined ? [bLine] : []
      const conflictOurs: string[] = oLine !== undefined ? [oLine] : []
      const conflictTheirs: string[] = tLine !== undefined ? [tLine] : []

      if (bLine !== undefined) bIdx += 1
      if (oLine !== undefined) oIdx += 1
      if (tLine !== undefined) tIdx += 1

      const conflictMergedLines = [
        `<<<<<<< ${oursLabel}`,
        ...conflictOurs,
        '=======',
        ...conflictTheirs,
        `>>>>>>> ${theirsLabel}`,
      ]

      chunks.push({
        status: 'CONFLICT',
        baseLines: conflictBase,
        oursLines: conflictOurs,
        theirsLines: conflictTheirs,
        mergedLines: conflictMergedLines,
      })
    }

    return chunks
  }
}
