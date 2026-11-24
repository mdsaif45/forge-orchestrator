import { describe, expect, it } from 'vitest'
import { ChangesetReversePatchSynthesizer } from './changesetReversePatchSynthesizer'

describe('ChangesetReversePatchSynthesizer (EVIDENCE-027)', () => {
  const synthesizer = new ChangesetReversePatchSynthesizer()

  it('inverts single-hunk diff swapping additions and deletions and hunk coordinates', () => {
    const forwardPatch = [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -10,4 +10,5 @@ function compute() {',
      '   const a = 1',
      '-  const b = 2',
      '+  const b = 20',
      '+  const c = 30',
      '   return a + b',
      ' }',
    ].join('\n')

    const { reversePatch, hunks, totalAdditionsInverted, totalDeletionsInverted } =
      synthesizer.synthesizeReversePatch(forwardPatch)

    expect(hunks).toHaveLength(1)
    expect(totalAdditionsInverted).toBe(2)
    expect(totalDeletionsInverted).toBe(1)

    const hunk = hunks[0]!
    expect(hunk.oldStart).toBe(10)
    expect(hunk.oldLines).toBe(5)
    expect(hunk.newStart).toBe(10)
    expect(hunk.newLines).toBe(4)

    expect(reversePatch).toContain('@@ -10,5 +10,4 @@ function compute() {')
    expect(reversePatch).toContain('-  const b = 20')
    expect(reversePatch).toContain('-  const c = 30')
    expect(reversePatch).toContain('+  const b = 2')
  })

  it('inverts multi-hunk patch across multiple regions of a file', () => {
    const forwardPatch = [
      'diff --git a/config.ts b/config.ts',
      '--- a/config.ts',
      '+++ b/config.ts',
      '@@ -5,3 +5,4 @@',
      ' line1',
      '-line2_old',
      '+line2_new',
      '+line2_extra',
      ' line3',
      '@@ -20,4 +21,3 @@',
      ' line20',
      '-line21_remove',
      '-line22_remove',
      '+line21_replace',
      ' line23',
    ].join('\n')

    const { hunks, totalAdditionsInverted, totalDeletionsInverted } =
      synthesizer.synthesizeReversePatch(forwardPatch)

    expect(hunks).toHaveLength(2)
    expect(totalAdditionsInverted).toBe(3) // 2 in hunk 1, 1 in hunk 2
    expect(totalDeletionsInverted).toBe(3) // 1 in hunk 1, 2 in hunk 2

    expect(hunks[0]!.invertedHeader).toBe('@@ -5,4 +5,3 @@')
    expect(hunks[1]!.invertedHeader).toBe('@@ -21,3 +20,4 @@')
  })

  it('inverts file creation into file deletion and vice versa with /dev/null swapping', () => {
    const creationPatch = [
      'diff --git a/newfile.txt b/newfile.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/newfile.txt',
      '@@ -0,0 +1,2 @@',
      '+first line',
      '+second line',
    ].join('\n')

    const details = synthesizer.synthesizeReversePatch(creationPatch)
    expect(details.reversePatch).toContain('deleted file mode 100644')
    expect(details.reversePatch).toContain('--- a/newfile.txt')
    expect(details.reversePatch).toContain('+++ /dev/null')
    expect(details.reversePatch).toContain('@@ -1,2 +0,0 @@')
    expect(details.reversePatch).toContain('-first line')
    expect(details.reversePatch).toContain('-second line')
  })

  it('performs virtual in-memory dry run and validates cryptographic SHA-256 rollback match', () => {
    const original = ['line1', 'line2_old', 'line3', 'line4', 'line5'].join('\n')
    const modified = ['line1', 'line2_new', 'line2_extra', 'line3', 'line4', 'line5'].join('\n')

    const patch = [
      '--- a/test.txt',
      '+++ b/test.txt',
      '@@ -1,4 +1,5 @@',
      ' line1',
      '-line2_old',
      '+line2_new',
      '+line2_extra',
      ' line3',
      ' line4',
    ].join('\n')

    const verification = synthesizer.verifyRollback({
      patch,
      originalBuffer: original,
      modifiedBuffer: modified,
    })

    expect(verification.valid).toBe(true)
    expect(verification.dryRunSuccess).toBe(true)
    expect(verification.collisionDetected).toBe(false)
    expect(verification.expectedRollbackHash).toBeDefined()
    expect(verification.actualRollbackHash).toBeDefined()
    expect(verification.actualRollbackHash).toBe(verification.expectedRollbackHash)
  })

  it('detects collision and desync when target buffer content differs from expected hunk context', () => {
    const original = ['line1', 'line2_old', 'line3'].join('\n')
    const diverged = ['line1', 'CONFLICTING_LINE_CONTENT', 'line3'].join('\n')

    const patch = [
      '--- a/test.txt',
      '+++ b/test.txt',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-line2_old',
      '+line2_new',
      ' line3',
    ].join('\n')

    const verification = synthesizer.verifyRollback({
      patch,
      originalBuffer: original,
      modifiedBuffer: diverged,
    })

    expect(verification.valid).toBe(false)
    expect(verification.dryRunSuccess).toBe(false)
    expect(verification.collisionDetected).toBe(true)
    expect(verification.error).toContain('Collision detected')
  })

  it('detects boundary out of range collision when hunk offset exceeds buffer line count', () => {
    const modified = ['short', 'buffer'].join('\n')
    const patch = [
      '--- a/test.txt',
      '+++ b/test.txt',
      '@@ -100,2 +100,2 @@',
      ' line100',
      '-old',
      '+new',
    ].join('\n')

    const verification = synthesizer.verifyRollback({
      patch,
      originalBuffer: 'anything',
      modifiedBuffer: modified,
    })

    expect(verification.valid).toBe(false)
    expect(verification.collisionDetected).toBe(true)
    expect(verification.error).toContain('Hunk boundary out of range')
  })

  it('returns valid: false when patch contains no recognizable hunks', () => {
    const invalidPatch = 'Not a valid patch content at all'
    const result = synthesizer.verifyRollback({ patch: invalidPatch })

    expect(result.valid).toBe(false)
    expect(result.error).toContain('Invalid patch format')
  })

  it('handles empty patch cleanly with zero hunks', () => {
    const result = synthesizer.synthesizeReversePatch('')
    expect(result.reversePatch).toBe('')
    expect(result.hunks).toHaveLength(0)
    expect(result.totalAdditionsInverted).toBe(0)
  })
})
