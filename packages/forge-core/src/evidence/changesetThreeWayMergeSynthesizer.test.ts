import { describe, expect, it } from 'vitest'
import { ChangesetThreeWayMergeSynthesizer } from './changesetThreeWayMergeSynthesizer'

describe('ChangesetThreeWayMergeSynthesizer', () => {
  it('returns clean base report when all three buffers are identical', () => {
    const synthesizer = new ChangesetThreeWayMergeSynthesizer()
    const content = 'line 1\nline 2\nline 3'
    const report = synthesizer.merge(content, content, content)

    expect(report.hasConflicts).toBe(false)
    expect(report.conflictsCount).toBe(0)
    expect(report.mergedContent).toBe(content)
    expect(report.chunks[0]?.status).toBe('CLEAN_BASE')
  })

  it('applies ours modification cleanly when theirs is untouched', () => {
    const synthesizer = new ChangesetThreeWayMergeSynthesizer()
    const base = 'line 1\nline 2'
    const ours = 'line 1\nline 2 (modified)'
    const theirs = 'line 1\nline 2'

    const report = synthesizer.merge(base, ours, theirs)
    expect(report.hasConflicts).toBe(false)
    expect(report.mergedContent).toBe(ours)
    expect(report.chunks[0]?.status).toBe('CLEAN_OURS')
  })

  it('applies theirs modification cleanly when ours is untouched', () => {
    const synthesizer = new ChangesetThreeWayMergeSynthesizer()
    const base = 'line 1\nline 2'
    const ours = 'line 1\nline 2'
    const theirs = 'line 1\nline 2 (theirs mod)'

    const report = synthesizer.merge(base, ours, theirs)
    expect(report.hasConflicts).toBe(false)
    expect(report.mergedContent).toBe(theirs)
    expect(report.chunks[0]?.status).toBe('CLEAN_THEIRS')
  })

  it('merges cleanly when both branches make identical modifications', () => {
    const synthesizer = new ChangesetThreeWayMergeSynthesizer()
    const base = 'line 1\nline 2'
    const ours = 'line 1\nline 2 (both)'
    const theirs = 'line 1\nline 2 (both)'

    const report = synthesizer.merge(base, ours, theirs)
    expect(report.hasConflicts).toBe(false)
    expect(report.mergedContent).toBe(ours)
    expect(report.chunks[0]?.status).toBe('CLEAN_BOTH_SAME')
  })

  it('auto-merges disjoint modifications across different lines', () => {
    const synthesizer = new ChangesetThreeWayMergeSynthesizer()
    const base = 'line 1\nline 2\nline 3'
    const ours = 'line 1 (ours mod)\nline 2\nline 3'
    const theirs = 'line 1\nline 2\nline 3 (theirs mod)'

    const report = synthesizer.merge(base, ours, theirs)
    expect(report.hasConflicts).toBe(false)
    expect(report.mergedContent).toBe('line 1 (ours mod)\nline 2\nline 3 (theirs mod)')
  })

  it('detects genuine conflicting overlapping edits and injects conflict markers', () => {
    const synthesizer = new ChangesetThreeWayMergeSynthesizer()
    const base = 'common header\noriginal code\ncommon footer'
    const ours = 'common header\ncode updated by ours\ncommon footer'
    const theirs = 'common header\ncode rewritten by theirs\ncommon footer'

    const report = synthesizer.merge(base, ours, theirs, {
      oursLabel: 'HEAD',
      theirsLabel: 'feature-branch',
    })

    expect(report.hasConflicts).toBe(true)
    expect(report.conflictsCount).toBe(1)
    expect(report.mergedContent).toContain('<<<<<<< HEAD')
    expect(report.mergedContent).toContain('code updated by ours')
    expect(report.mergedContent).toContain('=======')
    expect(report.mergedContent).toContain('code rewritten by theirs')
    expect(report.mergedContent).toContain('>>>>>>> feature-branch')
  })
})
