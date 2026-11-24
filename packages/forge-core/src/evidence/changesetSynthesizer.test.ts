import { describe, expect, it } from 'vitest'
import { synthesizeChangesetCommit } from './changesetSynthesizer'

describe('changesetSynthesizer (DIFF-003)', () => {
  const sampleDiff = `diff --git a/src/main/core/tokenAccounting.ts b/src/main/core/tokenAccounting.ts
index 1234..5678 100644
--- a/src/main/core/tokenAccounting.ts
+++ b/src/main/core/tokenAccounting.ts
@@ -10,2 +10,4 @@
+export function calculateBudget() {}
+export const DEFAULT_BUDGET = 5000
`

  it('synthesizes structured conventional commit from diff', () => {
    const report = synthesizeChangesetCommit(sampleDiff, {
      task: 'implement token budget calculator',
    })

    expect(report.valid).toBe(true)
    expect(report.type).toBe('feat')
    expect(report.scope).toBe('core')
    expect(report.header).toBe('feat(core): implement token budget calculator')
    expect(report.filesChanged).toContain('src/main/core/tokenAccounting.ts')
    expect(report.totalAdditions).toBe(2)
    expect(report.totalDeletions).toBe(0)
    expect(report.breaking).toBe(false)
  })

  it('detects fix type when task mentions bug fix', () => {
    const report = synthesizeChangesetCommit(sampleDiff, {
      task: 'fix calculation overflow bug',
    })

    expect(report.valid).toBe(true)
    expect(report.type).toBe('fix')
    expect(report.header).toBe('fix(core): fix calculation overflow bug')
  })

  it('detects breaking changes when BREAKING CHANGE is present in additions', () => {
    const breakingDiff = `diff --git a/src/main/db/schema.ts b/src/main/db/schema.ts
--- a/src/main/db/schema.ts
+++ b/src/main/db/schema.ts
@@ -1,2 +1,3 @@
+// BREAKING CHANGE: table columns renamed
`
    const report = synthesizeChangesetCommit(breakingDiff, {
      task: 'rename database columns',
    })

    expect(report.valid).toBe(true)
    expect(report.breaking).toBe(true)
    expect(report.header).toContain('!')
    expect(report.body).toContain('BREAKING CHANGE:')
  })

  it('fails closed on empty diff (Axiom A2)', () => {
    const emptyReport = synthesizeChangesetCommit('')
    expect(emptyReport.valid).toBe(false)
    expect(emptyReport.error).toBe('Empty changeset diff')
  })
})
