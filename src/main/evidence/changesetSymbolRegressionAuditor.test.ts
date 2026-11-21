import { describe, expect, it } from 'vitest'
import { ChangesetSymbolRegressionAuditor } from './changesetSymbolRegressionAuditor'

describe('ChangesetSymbolRegressionAuditor', () => {
  it('flags completely removed exports as breaking regressions with severity 50', () => {
    const auditor = new ChangesetSymbolRegressionAuditor()
    const diff = `
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,5 +1,2 @@
-export function calculateTax(amount: number): number {
-  return amount * 0.2
-}
 export const VERSION = '1.0.0'
`
    const result = auditor.auditDiff(diff)
    expect(result.hasBreakingChanges).toBe(true)
    expect(result.breakingCount).toBe(1)
    expect(result.totalSeverityScore).toBe(50)
    expect(result.symbolDiffs[0]?.symbolName).toBe('calculateTax')
    expect(result.symbolDiffs[0]?.changeKind).toBe('REMOVED_EXPORT')
  })

  it('flags mutated export signatures as breaking regressions', () => {
    const auditor = new ChangesetSymbolRegressionAuditor()
    const diff = `
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,3 +1,3 @@
-export interface UserProfile { id: string }
+export interface UserProfile { id: string; role: string }
`
    const result = auditor.auditDiff(diff)
    expect(result.hasBreakingChanges).toBe(true)
    expect(result.breakingCount).toBe(1)
    expect(result.totalSeverityScore).toBe(25)
    expect(result.symbolDiffs[0]?.symbolName).toBe('UserProfile')
    expect(result.symbolDiffs[0]?.changeKind).toBe('SIGNATURE_MUTATION')
  })

  it('detects visibility restrictions when export keyword is removed', () => {
    const auditor = new ChangesetSymbolRegressionAuditor()
    const diff = `
--- a/src/internal.ts
+++ b/src/internal.ts
@@ -1,3 +1,3 @@
-export function helper(): void {}
+function helper(): void {}
`
    const result = auditor.auditDiff(diff)
    expect(result.hasBreakingChanges).toBe(true)
    expect(result.breakingCount).toBe(1)
    expect(result.totalSeverityScore).toBe(40)
    expect(result.symbolDiffs[0]?.changeKind).toBe('VISIBILITY_RESTRICTION')
  })

  it('treats brand new exports as compatible additions with zero severity score', () => {
    const auditor = new ChangesetSymbolRegressionAuditor()
    const diff = `
--- a/src/features.ts
+++ b/src/features.ts
@@ -1,2 +1,4 @@
 export const FEATURE_A = true
+export const FEATURE_B = true
+export function newHelper(): string { return 'ok' }
`
    const result = auditor.auditDiff(diff)
    expect(result.hasBreakingChanges).toBe(false)
    expect(result.breakingCount).toBe(0)
    expect(result.compatibleCount).toBe(2)
    expect(result.totalSeverityScore).toBe(0)
    expect(result.recommendations[0]).toMatch(/backwards-compatible/i)
  })

  it('handles clean diffs with no export changes', () => {
    const auditor = new ChangesetSymbolRegressionAuditor()
    const diff = `
--- a/src/test.txt
+++ b/src/test.txt
@@ -1 +1 @@
-hello
+world
`
    const result = auditor.auditDiff(diff)
    expect(result.hasBreakingChanges).toBe(false)
    expect(result.totalSymbolChanges).toBe(0)
    expect(result.recommendations[0]).toMatch(/No public export modifications/i)
  })
})
