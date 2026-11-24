import { describe, expect, it } from 'vitest'
import { sliceChangesetForContextBudget } from './changesetContextBudgetSlicer'

describe('ChangesetContextBudgetSlicer', () => {
  const samplePatch = `diff --git a/src/math.ts b/src/math.ts
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,3 +1,4 @@
 export function add(a: number, b: number): number {
-  return a;
+  return a + b;
 }
@@ -10,3 +11,4 @@
 export function multiply(a: number, b: number): number {
-  return 0;
+  return a * b;
 }
`

  it('preserves complete patch without truncation when it fits within budget', () => {
    const report = sliceChangesetForContextBudget(samplePatch, { maxTokenBudget: 500 })
    expect(report.isTruncated).toBe(false)
    expect(report.retainedHunks).toBe(2)
    expect(report.omittedHunks).toBe(0)
    expect(report.slicedDiff).toBe(samplePatch)
    expect(report.summary).toContain('Full patch fits within budget')
  })

  it('slices patch and omits hunks when token budget is strictly constrained', () => {
    // Budget constrained to ~30 tokens
    const report = sliceChangesetForContextBudget(samplePatch, { maxTokenBudget: 40 })
    expect(report.isTruncated).toBe(true)
    expect(report.retainedHunks).toBeGreaterThanOrEqual(1)
    expect(report.omittedHunks).toBeGreaterThanOrEqual(1)
    expect(report.slicedDiff).toMatch(/(add|multiply)\(a: number, b: number\)/)
    expect(report.slicedDiff).toContain('# [Hunk omitted:')
  })

  it('maintains valid file headers even when hunks are omitted', () => {
    const report = sliceChangesetForContextBudget(samplePatch, { maxTokenBudget: 40 })
    expect(report.slicedDiff).toContain('diff --git a/src/math.ts b/src/math.ts')
    expect(report.slicedDiff).toContain('+++ b/src/math.ts')
  })

  it('handles multi-file patches and attributes omissions to proper files', () => {
    const multiFilePatch = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 export const A = 1;
+export const A2 = 2;
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,3 @@
 export const B = 100;
+export const B2 = 200;
`
    const report = sliceChangesetForContextBudget(multiFilePatch, { maxTokenBudget: 35 })
    expect(report.totalHunks).toBe(2)
    expect(report.isTruncated).toBe(true)
  })

  it('gracefully handles empty diff content with 0 tokens', () => {
    const report = sliceChangesetForContextBudget('', { maxTokenBudget: 100 })
    expect(report.originalTokens).toBe(0)
    expect(report.isTruncated).toBe(false)
    expect(report.retainedHunks).toBe(0)
  })
})
