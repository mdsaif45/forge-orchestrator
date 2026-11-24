import { describe, expect, it } from 'vitest'
import {
  detectChangesetConflicts,
  mergeChangesetDiffs,
  parseUnifiedDiff,
} from './changesetConflictDetector'

describe('Changeset Conflict Detector & Merger (DIFF-004)', () => {
  const diffA = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,5 +10,6 @@ export function verifyToken(token: string): boolean {
   if (!token) return false
+  // Added validation
   return true
 }
`

  const diffB_Disjoint = `diff --git a/src/utils.ts b/src/utils.ts
index 3333333..4444444 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,4 @@
 export function formatDate(d: Date): string {
+  // formatted
   return d.toISOString()
 }
`

  const diffB_Colliding = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..5555555 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -12,4 +12,5 @@ export function verifyToken(token: string): boolean {
-  return true
+  return false // colliding line
 }
`

  const diffB_NonCollidingSameFile = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..6666666 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -50,5 +50,6 @@ export function logout(): void {
+  // logout audit
   console.log("logout")
 }
`

  it('parses unified diff into structured file diffs and hunks', () => {
    const files = parseUnifiedDiff(diffA)
    expect(files.length).toBe(1)
    expect(files[0]?.newPath).toBe('src/auth.ts')
    expect(files[0]?.hunks.length).toBe(1)
    expect(files[0]?.hunks[0]?.oldStart).toBe(10)
  })

  it('reports clean when changesets touch completely disjoint files', () => {
    const report = detectChangesetConflicts(diffA, diffB_Disjoint)
    expect(report.valid).toBe(true)
    expect(report.hasConflicts).toBe(false)
    expect(report.overlappingFiles.length).toBe(0)
    expect(report.conflicts.length).toBe(0)
  })

  it('reports clean when touching same file at disjoint line ranges', () => {
    const report = detectChangesetConflicts(diffA, diffB_NonCollidingSameFile)
    expect(report.valid).toBe(true)
    expect(report.hasConflicts).toBe(false)
    expect(report.overlappingFiles).toContain('src/auth.ts')
    expect(report.conflicts.length).toBe(0)
  })

  it('detects hunk collision and fails closed when line spans overlap', () => {
    const report = detectChangesetConflicts(diffA, diffB_Colliding)
    expect(report.valid).toBe(true)
    expect(report.hasConflicts).toBe(true)
    expect(report.conflicts.length).toBe(1)
    expect(report.conflicts[0]?.type).toBe('hunk-collision')
    expect(report.conflicts[0]?.filePath).toBe('src/auth.ts')
  })

  it('merges disjoint changesets into a unified patch and aborts on conflict', () => {
    const cleanMerge = mergeChangesetDiffs(diffA, diffB_Disjoint)
    expect(cleanMerge.success).toBe(true)
    expect(cleanMerge.mergedPatch).toContain('diff --git a/src/auth.ts')
    expect(cleanMerge.mergedPatch).toContain('diff --git a/src/utils.ts')

    const collidingMerge = mergeChangesetDiffs(diffA, diffB_Colliding)
    expect(collidingMerge.success).toBe(false)
    expect(collidingMerge.mergedPatch).toBeNull()
    expect(collidingMerge.formattedSummary).toContain('Merge aborted')
  })
})
