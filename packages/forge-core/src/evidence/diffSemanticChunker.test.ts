import { describe, expect, it } from 'vitest'
import { chunkUnifiedDiff, classifyFilePath } from './diffSemanticChunker'

describe('diffSemanticChunker (EVIDENCE-016)', () => {
  it('classifies file paths into semantic categories accurately', () => {
    expect(classifyFilePath('src/main/db/schema.ts')).toBe('SCHEMA_MUTATION')
    expect(classifyFilePath('migrations/001_init.sql')).toBe('SCHEMA_MUTATION')
    expect(classifyFilePath('src/main/core/agent.test.ts')).toBe('TEST_SUITE')
    expect(classifyFilePath('package.json')).toBe('BUILD_CONFIG')
    expect(classifyFilePath('tsconfig.node.json')).toBe('BUILD_CONFIG')
    expect(classifyFilePath('docs/architecture/adr-001.md')).toBe('DOCUMENTATION')
    expect(classifyFilePath('src/main/core/planner.ts')).toBe('CORE_LOGIC')
    expect(classifyFilePath('random.unknownext')).toBe('UNKNOWN')
  })

  it('handles empty diff input safely', () => {
    const report = chunkUnifiedDiff('')
    expect(report.chunks).toEqual([])
    expect(report.totalChunks).toBe(0)
    expect(report.totalAdded).toBe(0)
    expect(report.totalDeleted).toBe(0)
    expect(report.overallRisk).toBe('LOW')
  })

  it('parses unified git diff into structured semantic chunks with symbol extraction', () => {
    const rawDiff = `
diff --git a/src/main/core/service.ts b/src/main/core/service.ts
index abc..def 100644
--- a/src/main/core/service.ts
+++ b/src/main/core/service.ts
@@ -10,4 +10,6 @@ export function existingFunc() {
-  const oldVar = 1;
+  const newVar = 2;
+  export function calculateTotal() { return 42; }
`

    const report = chunkUnifiedDiff(rawDiff)
    expect(report.totalChunks).toBe(1)
    expect(report.totalAdded).toBe(2)
    expect(report.totalDeleted).toBe(1)
    const firstChunk = report.chunks[0]
    expect(firstChunk).toBeDefined()
    expect(firstChunk?.filePath).toBe('src/main/core/service.ts')
    expect(firstChunk?.category).toBe('CORE_LOGIC')
    expect(firstChunk?.modifiedSymbols).toContain('calculateTotal')
    expect(firstChunk?.summary).toContain('[CORE_LOGIC] src/main/core/service.ts +2/-1')
  })

  it('assigns CRITICAL / HIGH risk to schema changes and configuration changes', () => {
    const schemaDiff = `
diff --git a/src/main/db/schema.ts b/src/main/db/schema.ts
--- a/src/main/db/schema.ts
+++ b/src/main/db/schema.ts
@@ -1,5 +1,10 @@
+export const NEW_SCHEMA = "CREATE TABLE users (id TEXT PRIMARY KEY)";
`

    const report = chunkUnifiedDiff(schemaDiff)
    expect(report.dominantCategory).toBe('SCHEMA_MUTATION')
    expect(report.overallRisk).toBe('HIGH')
  })

  it('enforces maxChunks truncation when configured', () => {
    const multiDiff = `
diff --git a/a.ts b/a.ts
@@ -1,1 +1,1 @@
+const a = 1;
diff --git a/b.ts b/b.ts
@@ -1,1 +1,1 @@
+const b = 2;
diff --git a/c.ts b/c.ts
@@ -1,1 +1,1 @@
+const c = 3;
`

    const report = chunkUnifiedDiff(multiDiff, { maxChunks: 2 })
    expect(report.totalChunks).toBe(2)
    expect(report.isTruncated).toBe(true)
  })
})
