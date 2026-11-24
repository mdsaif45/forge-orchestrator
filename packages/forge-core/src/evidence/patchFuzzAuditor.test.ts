import { describe, expect, it } from 'vitest'
import { auditPatchFuzziness, parseDiffHunks } from './patchFuzzAuditor'

describe('patchFuzzAuditor (EVIDENCE-009)', () => {
  const sampleDiff = `diff --git a/src/index.ts b/src/index.ts
index 1111111..2222222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -3,4 +3,4 @@
 export function existing(): void {
-  console.log('old')
+  console.log('new')
 }
`

  it('parses unified diff hunks correctly', () => {
    const files = parseDiffHunks(sampleDiff)
    expect(files).toHaveLength(1)
    expect(files[0]?.targetFile).toBe('src/index.ts')
    expect(files[0]?.hunks).toHaveLength(1)
    const hunk = files[0]?.hunks[0]
    expect(hunk?.oldStart).toBe(3)
    expect(hunk?.oldLength).toBe(4)
    expect(hunk?.originalLines).toEqual([
      'export function existing(): void {',
      "  console.log('old')",
      '}',
    ])
  })

  it('audits exact clean patch match against file content (offset 0)', async () => {
    const fileContent = [
      '// Header line 1',
      '// Header line 2',
      'export function existing(): void {',
      "  console.log('old')",
      '}',
      '// Footer line',
    ].join('\n')

    const report = await auditPatchFuzziness(sampleDiff, {
      fileReader: () => Promise.resolve(fileContent),
    })

    expect(report.valid).toBe(true)
    expect(report.overallStatus).toBe('clean')
    expect(report.cleanHunks).toBe(1)
    expect(report.fuzzyHunks).toBe(0)
    expect(report.rejectedHunks).toBe(0)
    expect(report.fileReports[0]?.hunks[0]?.offset).toBe(0)
  })

  it('audits fuzzy match with line drift offset within maxFuzz radius', async () => {
    // 2 extra lines inserted at top, so hunk shifted from line 3 to line 5 (+2 offset)
    const fileContent = [
      '// Header line 1',
      '// Header line 2',
      '// Extra inserted line A',
      '// Extra inserted line B',
      'export function existing(): void {',
      "  console.log('old')",
      '}',
      '// Footer line',
    ].join('\n')

    const report = await auditPatchFuzziness(sampleDiff, {
      fileReader: () => Promise.resolve(fileContent),
      maxFuzz: 3,
    })

    expect(report.valid).toBe(true)
    expect(report.overallStatus).toBe('fuzzy')
    expect(report.cleanHunks).toBe(0)
    expect(report.fuzzyHunks).toBe(1)
    expect(report.fileReports[0]?.hunks[0]?.offset).toBe(2)
  })

  it('rejects patch when context lines are not found within maxFuzz radius', async () => {
    const corruptedContent = [
      'function entirelyDifferent(): string {',
      '  return "unrelated";',
      '}',
    ].join('\n')

    const report = await auditPatchFuzziness(sampleDiff, {
      fileReader: () => Promise.resolve(corruptedContent),
      maxFuzz: 2,
    })

    expect(report.valid).toBe(false)
    expect(report.overallStatus).toBe('rejected')
    expect(report.rejectedHunks).toBe(1)
    expect(report.formattedSummary).toContain('REJECTED')
  })

  it('rejects patch when target file does not exist', async () => {
    const report = await auditPatchFuzziness(sampleDiff, {
      fileReader: () => Promise.resolve(null),
    })

    expect(report.valid).toBe(false)
    expect(report.overallStatus).toBe('rejected')
    expect(report.fileReports[0]?.hunks[0]?.reason).toContain('not found on disk')
  })
})
