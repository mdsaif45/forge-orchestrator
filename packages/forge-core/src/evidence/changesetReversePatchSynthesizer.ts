/**
 * EVIDENCE-027: Changeset reverse patch synthesizer and rollback verifier.
 *
 * Inverts applied diff hunks (+ <-> -), validates exact reverse applicability
 * against target buffers, detects partial or corrupted rollbacks, and produces
 * cryptographically verifiable rollback proofs (Axioms A1, A3, A6).
 */

import { createHash } from 'node:crypto'

export interface ReversePatchRequest {
  readonly patch: string
  readonly originalBuffer?: string | undefined
  readonly modifiedBuffer?: string | undefined
  readonly filePath?: string | undefined
}

export interface InvertedHunk {
  readonly originalHeader: string
  readonly invertedHeader: string
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly string[]
  readonly additionsInverted: number
  readonly deletionsInverted: number
  readonly contextLines: number
}

export interface RollbackVerificationResult {
  readonly valid: boolean
  readonly reversePatch: string
  readonly hunksInverted: number
  readonly totalAdditionsInverted: number
  readonly totalDeletionsInverted: number
  readonly hunks: readonly InvertedHunk[]
  readonly dryRunSuccess: boolean
  readonly expectedRollbackHash?: string | undefined
  readonly actualRollbackHash?: string | undefined
  readonly collisionDetected: boolean
  readonly error?: string | undefined
}

export interface SynthesizedPatchDetails {
  readonly reversePatch: string
  readonly hunks: readonly InvertedHunk[]
  readonly totalAdditionsInverted: number
  readonly totalDeletionsInverted: number
}

export interface VirtualApplyResult {
  readonly success: boolean
  readonly result?: string | undefined
  readonly collisionDetected: boolean
  readonly error?: string | undefined
}

export class ChangesetReversePatchSynthesizer {
  /**
   * Synthesizes an exact inverse (reverse) unified git diff patch with inverted hunk coordinates.
   */
  synthesizeReversePatch(rawPatch: string): SynthesizedPatchDetails {
    if (!rawPatch.trim()) {
      return {
        reversePatch: '',
        hunks: [],
        totalAdditionsInverted: 0,
        totalDeletionsInverted: 0,
      }
    }

    const lines = rawPatch.split(/\r?\n/)
    const out: string[] = []
    const hunks: InvertedHunk[] = []

    let inHunk = false
    let currentOriginalHeader = ''
    let currentInvertedHeader = ''
    let currentOldStart = 0
    let currentOldLines = 0
    let currentNewStart = 0
    let currentNewLines = 0
    let currentHunkLines: string[] = []
    let currentAdditionsInverted = 0
    let currentDeletionsInverted = 0
    let currentContextLines = 0

    const finalizeHunk = (): void => {
      if (!inHunk) return
      hunks.push({
        originalHeader: currentOriginalHeader,
        invertedHeader: currentInvertedHeader,
        oldStart: currentNewStart, // for reverse hunk, oldStart is forward's newStart
        oldLines: currentNewLines,
        newStart: currentOldStart,
        newLines: currentOldLines,
        lines: [...currentHunkLines],
        additionsInverted: currentAdditionsInverted,
        deletionsInverted: currentDeletionsInverted,
        contextLines: currentContextLines,
      })
      currentHunkLines = []
      currentAdditionsInverted = 0
      currentDeletionsInverted = 0
      currentContextLines = 0
      inHunk = false
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line === undefined) continue

      if (line.startsWith('diff --git ')) {
        finalizeHunk()
        out.push(line)
      } else if (line.startsWith('new file mode ')) {
        out.push(line.replace('new file mode ', 'deleted file mode '))
      } else if (line.startsWith('deleted file mode ')) {
        out.push(line.replace('deleted file mode ', 'new file mode '))
      } else if (line.startsWith('--- ')) {
        finalizeHunk()
        const nextLine = lines[i + 1]
        if (nextLine?.startsWith('+++ ')) {
          const oldFrom = line.slice(4).trim()
          const oldTo = nextLine.slice(4).trim()

          if (oldFrom === '/dev/null') {
            out.push(`--- a/${oldTo.replace(/^b\//, '')}`)
            out.push('+++ /dev/null')
          } else if (oldTo === '/dev/null') {
            out.push('--- /dev/null')
            out.push(`+++ b/${oldFrom.replace(/^a\//, '')}`)
          } else {
            out.push(`--- a/${oldTo.replace(/^b\//, '')}`)
            out.push(`+++ b/${oldFrom.replace(/^a\//, '')}`)
          }
          i++
        } else {
          out.push(line)
        }
      } else if (line.startsWith('@@ ')) {
        finalizeHunk()
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line)
        if (match) {
          inHunk = true
          currentOriginalHeader = line
          currentOldStart = parseInt(match[1] ?? '1', 10)
          currentOldLines = match[2] !== undefined ? parseInt(match[2], 10) : 1
          currentNewStart = parseInt(match[3] ?? '1', 10)
          currentNewLines = match[4] !== undefined ? parseInt(match[4], 10) : 1

          const fromLenStr = match[4] !== undefined ? `,${match[4]}` : ''
          const toLenStr = match[2] !== undefined ? `,${match[2]}` : ''
          const trailing = match[5] ?? ''

          currentInvertedHeader = `@@ -${String(currentNewStart)}${fromLenStr} +${String(currentOldStart)}${toLenStr} @@${trailing}`
          out.push(currentInvertedHeader)
        } else {
          out.push(line)
        }
      } else if (inHunk && line.startsWith('+')) {
        currentAdditionsInverted += 1
        const inverted = `-${line.slice(1)}`
        currentHunkLines.push(inverted)
        out.push(inverted)
      } else if (inHunk && line.startsWith('-')) {
        currentDeletionsInverted += 1
        const inverted = `+${line.slice(1)}`
        currentHunkLines.push(inverted)
        out.push(inverted)
      } else if (inHunk && line.startsWith(' ')) {
        currentContextLines += 1
        currentHunkLines.push(line)
        out.push(line)
      } else {
        out.push(line)
      }
    }

    finalizeHunk()

    let totalAdditionsInverted = 0
    let totalDeletionsInverted = 0
    for (const h of hunks) {
      totalAdditionsInverted += h.additionsInverted
      totalDeletionsInverted += h.deletionsInverted
    }

    return {
      reversePatch: out.join('\n'),
      hunks,
      totalAdditionsInverted,
      totalDeletionsInverted,
    }
  }

  /**
   * Applies an in-memory virtual unified patch to a string buffer without touching disk.
   */
  applyVirtualPatch(buffer: string, patch: string): VirtualApplyResult {
    if (!patch.trim()) {
      return { success: true, result: buffer, collisionDetected: false }
    }

    const parsedHunks = this.parseHunks(patch)
    if (parsedHunks.length === 0) {
      return {
        success: false,
        collisionDetected: false,
        error: 'No parseable diff hunks found in patch.',
      }
    }

    const lines = buffer.split(/\r?\n/)
    let lineDelta = 0

    for (const hunk of parsedHunks) {
      const targetIndex = hunk.oldStart - 1 + lineDelta

      // Verify and collect expected vs replacement lines
      const expectedLines: string[] = []
      const replacementLines: string[] = []

      for (const line of hunk.lines) {
        if (line.startsWith(' ')) {
          expectedLines.push(line.slice(1))
          replacementLines.push(line.slice(1))
        } else if (line.startsWith('-')) {
          expectedLines.push(line.slice(1))
        } else if (line.startsWith('+')) {
          replacementLines.push(line.slice(1))
        }
      }

      // Check collision/desync against buffer
      if (targetIndex < 0 || targetIndex + expectedLines.length > lines.length + 1) {
        return {
          success: false,
          collisionDetected: true,
          error: `Hunk boundary out of range: expected line ${String(targetIndex + 1)}, total lines ${String(lines.length)}.`,
        }
      }

      for (let j = 0; j < expectedLines.length; j++) {
        const actualLine = lines[targetIndex + j]
        const expected = expectedLines[j]
        if (actualLine !== expected) {
          return {
            success: false,
            collisionDetected: true,
            error: `Collision detected at line ${String(targetIndex + j + 1)}: expected "${expected ?? ''}", got "${actualLine ?? ''}".`,
          }
        }
      }

      // Apply replacement
      lines.splice(targetIndex, expectedLines.length, ...replacementLines)
      lineDelta += replacementLines.length - expectedLines.length
    }

    return {
      success: true,
      result: lines.join('\n'),
      collisionDetected: false,
    }
  }

  /**
   * Verifies rollback reversibility, performing virtual dry-run and cryptographic hash matching.
   */
  verifyRollback(request: ReversePatchRequest): RollbackVerificationResult {
    const { reversePatch, hunks, totalAdditionsInverted, totalDeletionsInverted } =
      this.synthesizeReversePatch(request.patch)

    if (hunks.length === 0 && request.patch.trim().length > 0) {
      return {
        valid: false,
        reversePatch: '',
        hunksInverted: 0,
        totalAdditionsInverted: 0,
        totalDeletionsInverted: 0,
        hunks: [],
        dryRunSuccess: false,
        collisionDetected: false,
        error: 'Invalid patch format: no recognizable @@ hunks found.',
      }
    }

    let expectedRollbackHash: string | undefined
    let actualRollbackHash: string | undefined
    let dryRunSuccess = true
    let collisionDetected = false
    let error: string | undefined

    if (request.modifiedBuffer !== undefined && request.originalBuffer !== undefined) {
      expectedRollbackHash = createHash('sha256').update(request.originalBuffer).digest('hex')

      const applyRes = this.applyVirtualPatch(request.modifiedBuffer, reversePatch)
      if (!applyRes.success || applyRes.result === undefined) {
        dryRunSuccess = false
        collisionDetected = applyRes.collisionDetected
        error = applyRes.error ?? 'Virtual rollback patch application failed.'
      } else {
        actualRollbackHash = createHash('sha256').update(applyRes.result).digest('hex')
        if (actualRollbackHash !== expectedRollbackHash) {
          dryRunSuccess = false
          collisionDetected = true
          error = `Cryptographic rollback mismatch: expected hash ${expectedRollbackHash}, got ${actualRollbackHash}.`
        }
      }
    }

    const valid = hunks.length > 0 && dryRunSuccess && !collisionDetected

    return {
      valid,
      reversePatch,
      hunksInverted: hunks.length,
      totalAdditionsInverted,
      totalDeletionsInverted,
      hunks,
      dryRunSuccess,
      expectedRollbackHash,
      actualRollbackHash,
      collisionDetected,
      error,
    }
  }

  private parseHunks(patch: string): { oldStart: number; oldLines: number; lines: string[] }[] {
    const lines = patch.split(/\r?\n/)
    const result: { oldStart: number; oldLines: number; lines: string[] }[] = []

    let currentHunk: { oldStart: number; oldLines: number; lines: string[] } | null = null

    for (const line of lines) {
      if (line.startsWith('@@ ')) {
        if (currentHunk) {
          result.push(currentHunk)
        }
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
        if (match) {
          currentHunk = {
            oldStart: parseInt(match[1] ?? '1', 10),
            oldLines: match[2] !== undefined ? parseInt(match[2], 10) : 1,
            lines: [],
          }
        }
      } else if (
        currentHunk &&
        (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))
      ) {
        currentHunk.lines.push(line)
      }
    }

    if (currentHunk) {
      result.push(currentHunk)
    }

    return result
  }
}
