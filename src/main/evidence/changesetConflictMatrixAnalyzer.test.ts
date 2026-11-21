import { describe, it, expect } from 'vitest'
import {
  ChangesetConflictMatrixAnalyzer,
  type InputChangeset,
} from './changesetConflictMatrixAnalyzer'

describe('ChangesetConflictMatrixAnalyzer (EVIDENCE-022)', () => {
  const analyzer = new ChangesetConflictMatrixAnalyzer()

  it('reports score 100 and feasibility true for disjoint changesets', () => {
    const csA: InputChangeset = {
      id: 'cs-auth',
      patch: `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,5 +10,5 @@
 export function login() {}
`,
    }

    const csB: InputChangeset = {
      id: 'cs-db',
      patch: `diff --git a/src/db.ts b/src/db.ts
--- a/src/db.ts
+++ b/src/db.ts
@@ -20,5 +20,5 @@
 export function connect() {}
`,
    }

    const report = analyzer.analyzeConflictMatrix([csA, csB])
    expect(report.totalConflicts).toBe(0)
    expect(report.mergeFeasibilityScore).toBe(100)
    expect(report.isMergeFeasible).toBe(true)
    expect(report.totalFilesAudited).toBe(2)
  })

  it('detects direct line collisions on overlapping modification ranges', () => {
    const csA: InputChangeset = {
      id: 'branch-1',
      patch: `diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -15,10 +15,12 @@
 const a = 1;
`,
    }

    const csB: InputChangeset = {
      id: 'branch-2',
      patch: `diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -20,8 +20,10 @@
 const b = 2;
`,
    }

    const report = analyzer.analyzeConflictMatrix([csA, csB])
    expect(report.directCollisionsCount).toBe(1)
    expect(report.isMergeFeasible).toBe(false)
    expect(report.conflicts[0]?.severity).toBe('DIRECT_COLLISION')
    expect(report.conflicts[0]?.file).toBe('src/utils.ts')
    expect(report.conflicts[0]?.overlapSpan).toEqual([20, 26])
  })

  it('detects immediately adjacent hunks within 1 line boundary', () => {
    const csA: InputChangeset = {
      id: 'feature-a',
      patch: `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -10,5 +10,5 @@
 const first = true;
`,
    }

    const csB: InputChangeset = {
      id: 'feature-b',
      patch: `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -15,5 +15,5 @@
 const second = false;
`,
    }

    const report = analyzer.analyzeConflictMatrix([csA, csB])
    expect(report.directCollisionsCount).toBe(0)
    expect(report.adjacentCollisionsCount).toBe(1)
    expect(report.conflicts[0]?.severity).toBe('ADJACENT_HUNK')
    expect(report.mergeFeasibilityScore).toBe(90)
    expect(report.isMergeFeasible).toBe(true)
  })

  it('handles single changeset gracefully as trivially feasible', () => {
    const report = analyzer.analyzeConflictMatrix([
      { id: 'single', patch: 'diff --git a/file.ts b/file.ts\n@@ -1,1 +1,1 @@\n' },
    ])
    expect(report.mergeFeasibilityScore).toBe(100)
    expect(report.isMergeFeasible).toBe(true)
    expect(report.totalConflicts).toBe(0)
  })
})
