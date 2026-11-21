import { describe, it, expect } from 'vitest'
import { auditChangesetExportSurface } from './exportSurfaceAuditor'

describe('Changeset Export Surface Impact Auditor (EVIDENCE-008)', () => {
  it('returns clean report for empty diff', () => {
    const report = auditChangesetExportSurface('')
    expect(report.valid).toBe(true)
    expect(report.totalChanges).toBe(0)
    expect(report.riskTier).toBe('low')
  })

  it('detects newly added exported symbols with low risk', () => {
    const diff = `
diff --git a/src/service.ts b/src/service.ts
index 1111111..2222222 100644
--- a/src/service.ts
+++ b/src/service.ts
@@ -10,3 +10,6 @@
+export function calculateMetrics(): number {
+  return 42
+}
`
    const report = auditChangesetExportSurface(diff)
    expect(report.valid).toBe(true)
    expect(report.totalFilesScanned).toBe(1)
    expect(report.addedCount).toBe(1)
    expect(report.modifiedCount).toBe(0)
    expect(report.removedCount).toBe(0)
    expect(report.riskTier).toBe('low')
    expect(report.changes[0]?.symbol).toBe('calculateMetrics')
    expect(report.changes[0]?.changeKind).toBe('added')
    expect(report.changes[0]?.symbolKind).toBe('function')
  })

  it('detects modified export signatures with medium risk', () => {
    const diff = `
diff --git a/src/types.ts b/src/types.ts
index 1111111..2222222 100644
--- a/src/types.ts
+++ b/src/types.ts
@@ -5,3 +5,3 @@
-export interface UserConfig { id: string }
+export interface UserConfig { id: string; name: string }
`
    const report = auditChangesetExportSurface(diff)
    expect(report.valid).toBe(true)
    expect(report.modifiedCount).toBe(1)
    expect(report.riskTier).toBe('medium')
    expect(report.changes[0]?.symbol).toBe('UserConfig')
    expect(report.changes[0]?.changeKind).toBe('modified')
    expect(report.changes[0]?.symbolKind).toBe('interface')
  })

  it('detects removed public exports with high breaking risk', () => {
    const diff = `
diff --git a/src/api.ts b/src/api.ts
index 1111111..2222222 100644
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,5 +1,1 @@
-export const API_KEY = 'secret'
-export type OldType = string
`
    const report = auditChangesetExportSurface(diff)
    expect(report.valid).toBe(true)
    expect(report.removedCount).toBe(2)
    expect(report.riskTier).toBe('high')
    expect(report.changes.every((c) => c.isBreaking)).toBe(true)
  })
})
