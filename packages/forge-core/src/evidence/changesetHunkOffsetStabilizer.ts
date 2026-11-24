/**
 * Unified diff patch semantic fuzziness and hunk offset stabilizer.
 *
 * Scans buffer windows for patch context anchors, detects line drift from
 * concurrent edits, calculates fuzzy match confidence, and recalculates
 * stabilized hunk offsets to prevent patch rejection (A1, A3).
 */

export interface HunkInput {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly string[]
}

export interface StabilizedHunk {
  readonly hunkIndex: number
  readonly originalOldStart: number
  readonly stabilizedOldStart: number
  readonly offsetDelta: number
  readonly matchConfidence: number
  readonly fuzzyMatched: boolean
}

export interface OffsetStabilizationConflict {
  readonly hunkIndex: number
  readonly reason: string
  readonly candidateMatchesCount?: number | undefined
}

export interface OffsetStabilizationResult {
  readonly success: boolean
  readonly stabilizedHunks: readonly StabilizedHunk[]
  readonly totalDrift: number
  readonly conflict?: OffsetStabilizationConflict | undefined
}

export interface HunkStabilizerConfig {
  /** Maximum line search offset distance up or down from target line. Defaults to 50. */
  readonly maxSearchWindowLines?: number | undefined
  /** Minimum similarity score (0.0 - 1.0) required to accept a fuzzy match. Defaults to 0.8. */
  readonly minConfidenceThreshold?: number | undefined
  /** Ignore leading and trailing whitespace differences during anchor comparison. Defaults to true. */
  readonly ignoreWhitespace?: boolean | undefined
}

function normalizeLine(line: string, ignoreWhitespace: boolean): string {
  return ignoreWhitespace ? line.trim() : line
}

function calculateLineSimilarity(a: string, b: string, ignoreWhitespace: boolean): number {
  const normA = normalizeLine(a, ignoreWhitespace)
  const normB = normalizeLine(b, ignoreWhitespace)

  if (normA === normB) return 1.0
  if (normA.length === 0 || normB.length === 0) return 0.0

  // Quick character overlap similarity
  let matchingChars = 0
  const maxLen = Math.max(normA.length, normB.length)
  const minLen = Math.min(normA.length, normB.length)

  for (let i = 0; i < minLen; i += 1) {
    if (normA[i] === normB[i]) matchingChars += 1
  }

  return matchingChars / maxLen
}

export class ChangesetHunkOffsetStabilizer {
  private readonly maxSearchWindowLines: number
  private readonly minConfidenceThreshold: number
  private readonly ignoreWhitespace: boolean

  constructor(config: HunkStabilizerConfig = {}) {
    this.maxSearchWindowLines = Math.max(5, config.maxSearchWindowLines ?? 50)
    this.minConfidenceThreshold = Math.max(0.1, Math.min(1.0, config.minConfidenceThreshold ?? 0.8))
    this.ignoreWhitespace = config.ignoreWhitespace ?? true
  }

  /**
   * Evaluates hunks against the target buffer, recalculating line numbers to accommodate drift.
   */
  stabilize(
    bufferContent: string | readonly string[],
    hunks: readonly HunkInput[],
  ): OffsetStabilizationResult {
    const bufferLines =
      typeof bufferContent === 'string' ? bufferContent.split(/\r?\n/) : [...bufferContent]

    const stabilizedHunks: StabilizedHunk[] = []
    let accumulatedDrift = 0

    for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
      const hunk = hunks[hunkIndex]
      if (!hunk) continue

      // Extract expected old lines from hunk (context ' ' and deleted '-')
      const expectedOldLines: string[] = []
      for (const line of hunk.lines) {
        if (line.startsWith(' ') || line.startsWith('-')) {
          expectedOldLines.push(line.slice(1))
        }
      }

      // Expected line 1-based index shifted by prior drift
      const expectedOldStart = hunk.oldStart + accumulatedDrift

      // If hunk is purely additive with no old lines, anchor at expectedOldStart
      if (expectedOldLines.length === 0) {
        stabilizedHunks.push({
          hunkIndex,
          originalOldStart: hunk.oldStart,
          stabilizedOldStart: expectedOldStart,
          offsetDelta: accumulatedDrift,
          matchConfidence: 1.0,
          fuzzyMatched: false,
        })
        accumulatedDrift += hunk.newLines - hunk.oldLines
        continue
      }

      // 1. Check for exact match at expected location
      const exactMatch = this.checkAnchorMatch(bufferLines, expectedOldLines, expectedOldStart)
      if (exactMatch === 1.0) {
        stabilizedHunks.push({
          hunkIndex,
          originalOldStart: hunk.oldStart,
          stabilizedOldStart: expectedOldStart,
          offsetDelta: accumulatedDrift,
          matchConfidence: 1.0,
          fuzzyMatched: false,
        })
        accumulatedDrift += hunk.newLines - hunk.oldLines
        continue
      }

      // 2. Scan window for best anchor match
      const candidates = this.findCandidates(bufferLines, expectedOldLines, expectedOldStart)

      if (candidates.length === 0) {
        return {
          success: false,
          stabilizedHunks,
          totalDrift: accumulatedDrift,
          conflict: {
            hunkIndex,
            reason: `No anchor candidate reached confidence threshold ${String(this.minConfidenceThreshold)}`,
          },
        }
      }

      // Check for ambiguity (two top candidates tied with identical confidence)
      const topCandidate = candidates[0]
      const secondCandidate = candidates[1]

      if (!topCandidate) {
        return {
          success: false,
          stabilizedHunks,
          totalDrift: accumulatedDrift,
          conflict: {
            hunkIndex,
            reason: 'Unexpected empty candidate set',
          },
        }
      }

      if (
        secondCandidate &&
        Math.abs(topCandidate.confidence - secondCandidate.confidence) < 0.001 &&
        topCandidate.confidence >= this.minConfidenceThreshold
      ) {
        return {
          success: false,
          stabilizedHunks,
          totalDrift: accumulatedDrift,
          conflict: {
            hunkIndex,
            reason: `Ambiguous hunk match: multiple candidate locations tied at confidence ${(topCandidate.confidence * 100).toFixed(1)}%`,
            candidateMatchesCount: candidates.length,
          },
        }
      }

      if (topCandidate.confidence < this.minConfidenceThreshold) {
        return {
          success: false,
          stabilizedHunks,
          totalDrift: accumulatedDrift,
          conflict: {
            hunkIndex,
            reason: `Best candidate confidence ${(topCandidate.confidence * 100).toFixed(1)}% fell below required threshold ${(this.minConfidenceThreshold * 100).toFixed(1)}%`,
          },
        }
      }

      // Accepted stabilized candidate
      const offsetDelta = topCandidate.lineIndex - hunk.oldStart
      stabilizedHunks.push({
        hunkIndex,
        originalOldStart: hunk.oldStart,
        stabilizedOldStart: topCandidate.lineIndex,
        offsetDelta,
        matchConfidence: topCandidate.confidence,
        fuzzyMatched: topCandidate.confidence < 1.0,
      })

      // Update drift based on new offset delta plus hunk size delta
      accumulatedDrift = offsetDelta + (hunk.newLines - hunk.oldLines)
    }

    return {
      success: true,
      stabilizedHunks,
      totalDrift: accumulatedDrift,
    }
  }

  /**
   * Applies stabilized hunks to buffer content.
   */
  applyStabilized(
    bufferContent: string,
    hunks: readonly HunkInput[],
  ): { success: boolean; patchedContent?: string | undefined; error?: string | undefined } {
    const stabilization = this.stabilize(bufferContent, hunks)
    if (!stabilization.success) {
      return {
        success: false,
        error: stabilization.conflict?.reason ?? 'Offset stabilization failed',
      }
    }

    const lines = bufferContent.split(/\r?\n/)
    const currentLines = [...lines]

    // Apply hunks in reverse line order to preserve indices
    const sorted = [...stabilization.stabilizedHunks].sort(
      (a, b) => b.stabilizedOldStart - a.stabilizedOldStart,
    )

    for (const st of sorted) {
      const hunk = hunks[st.hunkIndex]
      if (!hunk) continue

      const startIdx = Math.max(0, st.stabilizedOldStart - 1)
      const replacementLines: string[] = []

      for (const line of hunk.lines) {
        if (line.startsWith(' ') || line.startsWith('+')) {
          replacementLines.push(line.slice(1))
        }
      }

      currentLines.splice(startIdx, hunk.oldLines, ...replacementLines)
    }

    return {
      success: true,
      patchedContent: currentLines.join('\n'),
    }
  }

  private checkAnchorMatch(
    bufferLines: readonly string[],
    expectedOldLines: readonly string[],
    startLine1Based: number,
  ): number {
    const startIdx = startLine1Based - 1
    if (startIdx < 0 || startIdx + expectedOldLines.length > bufferLines.length) {
      return 0.0
    }

    let matchCount = 0
    for (let i = 0; i < expectedOldLines.length; i += 1) {
      const bufLine = bufferLines[startIdx + i] ?? ''
      const expLine = expectedOldLines[i] ?? ''
      const sim = calculateLineSimilarity(bufLine, expLine, this.ignoreWhitespace)
      matchCount += sim
    }

    return matchCount / expectedOldLines.length
  }

  private findCandidates(
    bufferLines: readonly string[],
    expectedOldLines: readonly string[],
    centerLine1Based: number,
  ): { lineIndex: number; confidence: number }[] {
    const candidates: { lineIndex: number; confidence: number }[] = []
    const minLine = Math.max(1, centerLine1Based - this.maxSearchWindowLines)
    const maxLine = Math.min(
      bufferLines.length - expectedOldLines.length + 1,
      centerLine1Based + this.maxSearchWindowLines,
    )

    for (let candidateLine = minLine; candidateLine <= maxLine; candidateLine += 1) {
      const confidence = this.checkAnchorMatch(bufferLines, expectedOldLines, candidateLine)
      if (confidence >= this.minConfidenceThreshold) {
        candidates.push({ lineIndex: candidateLine, confidence })
      }
    }

    // Sort descending by confidence, then by distance to centerLine
    candidates.sort((a, b) => {
      if (Math.abs(b.confidence - a.confidence) > 0.001) {
        return b.confidence - a.confidence
      }
      return Math.abs(a.lineIndex - centerLine1Based) - Math.abs(b.lineIndex - centerLine1Based)
    })

    return candidates
  }
}
