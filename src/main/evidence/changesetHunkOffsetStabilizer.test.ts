import { describe, expect, it } from 'vitest'
import { ChangesetHunkOffsetStabilizer, type HunkInput } from './changesetHunkOffsetStabilizer'

describe('ChangesetHunkOffsetStabilizer (EVIDENCE-024)', () => {
  it('stabilizes clean hunks without offset shift', () => {
    const stabilizer = new ChangesetHunkOffsetStabilizer()
    const buffer = 'line1\nline2\nline3\nline4\nline5'
    const hunk: HunkInput = {
      oldStart: 2,
      oldLines: 2,
      newStart: 2,
      newLines: 2,
      lines: [' line2', '-line3', '+line3_modified', ' line4'],
    }

    const res = stabilizer.stabilize(buffer, [hunk])
    expect(res.success).toBe(true)
    expect(res.stabilizedHunks[0]?.stabilizedOldStart).toBe(2)
    expect(res.stabilizedHunks[0]?.offsetDelta).toBe(0)
    expect(res.stabilizedHunks[0]?.matchConfidence).toBe(1.0)
  })

  it('detects line drift and recalculates hunk start line when buffer shifted down', () => {
    const stabilizer = new ChangesetHunkOffsetStabilizer()
    // Buffer has 2 new lines inserted at the top by a concurrent edit
    const buffer = 'intro1\nintro2\nline1\nline2\nline3\nline4\nline5'
    const hunk: HunkInput = {
      oldStart: 2, // Originally targeted line2 at line 2
      oldLines: 2,
      newStart: 2,
      newLines: 2,
      lines: [' line2', '-line3', '+line3_changed'],
    }

    const res = stabilizer.stabilize(buffer, [hunk])
    expect(res.success).toBe(true)
    // line2 is now at line 4 (drift = +2)
    expect(res.stabilizedHunks[0]?.stabilizedOldStart).toBe(4)
    expect(res.stabilizedHunks[0]?.offsetDelta).toBe(2)
  })

  it('handles whitespace fuzziness when ignoreWhitespace is true', () => {
    const stabilizer = new ChangesetHunkOffsetStabilizer({ ignoreWhitespace: true })
    // Buffer has different indentation
    const buffer = '   line1\n   line2\n   line3'
    const hunk: HunkInput = {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [' line1', '-line2', '+line2_new'],
    }

    const res = stabilizer.stabilize(buffer, [hunk])
    expect(res.success).toBe(true)
    expect(res.stabilizedHunks[0]?.stabilizedOldStart).toBe(1)
    expect(res.stabilizedHunks[0]?.matchConfidence).toBe(1.0)
  })

  it('rejects ambiguous hunk matches with multiple identical candidates', () => {
    const stabilizer = new ChangesetHunkOffsetStabilizer()
    // Repeated pattern in buffer
    const buffer = 'block\nitem\nend\nblock\nitem\nend'
    const hunk: HunkInput = {
      oldStart: 10, // far from center
      oldLines: 3,
      newStart: 10,
      newLines: 3,
      lines: [' block', ' item', ' end'],
    }

    const res = stabilizer.stabilize(buffer, [hunk])
    expect(res.success).toBe(false)
    expect(res.conflict?.reason).toContain('Ambiguous hunk match')
  })

  it('applies stabilized hunks and returns patched content', () => {
    const stabilizer = new ChangesetHunkOffsetStabilizer()
    const buffer = 'header\nfoo\nbar\nbaz\nfooter'
    const hunk: HunkInput = {
      oldStart: 2,
      oldLines: 2,
      newStart: 2,
      newLines: 2,
      lines: [' foo', '-bar', '+bar_updated'],
    }

    const res = stabilizer.applyStabilized(buffer, [hunk])
    expect(res.success).toBe(true)
    expect(res.patchedContent).toContain('bar_updated')
    expect(res.patchedContent).not.toContain('bar\n')
  })
})
