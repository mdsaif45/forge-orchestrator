/**
 * Copyright (c) 2026 Forge Authors
 * Technology: TypeScript / Node.js
 * Architecture: Multi-File Changeset Conflict Matrix & Merge Feasibility Analyzer (EVIDENCE-022)
 * Axioms Enforced:
 *  - A1: Bugs are bounded & fail-closed (collisions detect merge hazards before git apply).
 *  - A3: Physical evidence beats claims (exact interval math determines feasibility).
 *  - A5: Bounded complexity and processing loops.
 *  - A7: Least privilege & integrity.
 */

export type ConflictSeverity = 'DIRECT_COLLISION' | 'ADJACENT_HUNK'

export interface ChangesetFileInterval {
  readonly file: string
  readonly startLine: number
  readonly endLine: number
  readonly hunkHeader: string
}

export interface InputChangeset {
  readonly id: string
  readonly patch: string
}

export interface ChangesetConflict {
  readonly file: string
  readonly changesetA: string
  readonly changesetB: string
  readonly linesA: readonly [number, number]
  readonly linesB: readonly [number, number]
  readonly overlapSpan: readonly [number, number]
  readonly severity: ConflictSeverity
}

export interface ChangesetConflictMatrixReport {
  readonly totalChangesets: number
  readonly totalFilesAudited: number
  readonly totalConflicts: number
  readonly directCollisionsCount: number
  readonly adjacentCollisionsCount: number
  readonly mergeFeasibilityScore: number
  readonly isMergeFeasible: boolean
  readonly conflicts: readonly ChangesetConflict[]
  readonly summary: string
}

function parsePatchIntervals(patch: string): ChangesetFileInterval[] {
  const intervals: ChangesetFileInterval[] = []
  const lines = patch.split(/\r?\n/)
  let currentFile = ''

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const parts = line.split(' ')
      currentFile = parts[3]?.slice(2) ?? 'unknown'
    } else if (line.startsWith('@@ ')) {
      // e.g., @@ -15,6 +15,9 @@
      const match = /@@\s+-[0-9,]+\s+\+([0-9]+)(?:,([0-9]+))?\s+@@/.exec(line)
      if (match) {
        const start = parseInt(match[1] ?? '1', 10)
        const count = match[2] ? parseInt(match[2], 10) : 1
        const end = start + Math.max(1, count) - 1
        intervals.push({
          file: currentFile,
          startLine: start,
          endLine: end,
          hunkHeader: line,
        })
      }
    }
  }

  return intervals
}

export class ChangesetConflictMatrixAnalyzer {
  /**
   * Analyzes multi-file changeset overlap and computes merge feasibility scores.
   */
  public analyzeConflictMatrix(
    changesets: readonly InputChangeset[],
  ): ChangesetConflictMatrixReport {
    if (changesets.length <= 1) {
      return {
        totalChangesets: changesets.length,
        totalFilesAudited: 0,
        totalConflicts: 0,
        directCollisionsCount: 0,
        adjacentCollisionsCount: 0,
        mergeFeasibilityScore: 100,
        isMergeFeasible: true,
        conflicts: [],
        summary: `Trivially feasible: ${String(changesets.length)} changeset(s) submitted.`,
      }
    }

    const changesetIntervals = new Map<string, ChangesetFileInterval[]>()
    const allFiles = new Set<string>()

    for (const cs of changesets) {
      const parsed = parsePatchIntervals(cs.patch)
      changesetIntervals.set(cs.id, parsed)
      for (const inv of parsed) {
        allFiles.add(inv.file)
      }
    }

    const conflicts: ChangesetConflict[] = []
    let directCollisions = 0
    let adjacentCollisions = 0

    for (let i = 0; i < changesets.length; i++) {
      for (let j = i + 1; j < changesets.length; j++) {
        const csA = changesets[i]
        const csB = changesets[j]
        if (!csA || !csB) continue

        const intervalsA = changesetIntervals.get(csA.id) ?? []
        const intervalsB = changesetIntervals.get(csB.id) ?? []

        for (const intA of intervalsA) {
          for (const intB of intervalsB) {
            if (intA.file !== intB.file) continue

            const maxStart = Math.max(intA.startLine, intB.startLine)
            const minEnd = Math.min(intA.endLine, intB.endLine)

            if (maxStart <= minEnd) {
              // Direct overlap collision
              directCollisions++
              conflicts.push({
                file: intA.file,
                changesetA: csA.id,
                changesetB: csB.id,
                linesA: [intA.startLine, intA.endLine],
                linesB: [intB.startLine, intB.endLine],
                overlapSpan: [maxStart, minEnd],
                severity: 'DIRECT_COLLISION',
              })
            } else if (maxStart - minEnd === 1) {
              // Immediately adjacent (within 1 line boundary)
              adjacentCollisions++
              conflicts.push({
                file: intA.file,
                changesetA: csA.id,
                changesetB: csB.id,
                linesA: [intA.startLine, intA.endLine],
                linesB: [intB.startLine, intB.endLine],
                overlapSpan: [minEnd, maxStart],
                severity: 'ADJACENT_HUNK',
              })
            }
          }
        }
      }
    }

    const totalConflicts = conflicts.length
    // Deduct 25 points per direct collision, 10 points per adjacent collision
    const penalty = directCollisions * 25 + adjacentCollisions * 10
    const mergeFeasibilityScore = Math.max(0, 100 - penalty)
    const isMergeFeasible = directCollisions === 0 && mergeFeasibilityScore >= 60

    const summary = isMergeFeasible
      ? `Merge is feasible (Score: ${String(mergeFeasibilityScore)}/100, Direct Collisions: 0, Adjacent: ${String(adjacentCollisions)} across ${String(allFiles.size)} files).`
      : `Merge is hazardous (Score: ${String(mergeFeasibilityScore)}/100, Direct Collisions: ${String(directCollisions)}, Adjacent: ${String(adjacentCollisions)}). Conflicting changesets must be rebased.`

    return {
      totalChangesets: changesets.length,
      totalFilesAudited: allFiles.size,
      totalConflicts,
      directCollisionsCount: directCollisions,
      adjacentCollisionsCount: adjacentCollisions,
      mergeFeasibilityScore,
      isMergeFeasible,
      conflicts,
      summary,
    }
  }
}
