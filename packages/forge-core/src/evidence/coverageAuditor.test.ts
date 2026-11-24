import { describe, expect, it } from 'vitest'
import { auditChangesetCoverage, extractModifiedLineNumbers, parseLcov } from './coverageAuditor'

const SAMPLE_DIFF = `
diff --git a/src/auth.ts b/src/auth.ts
index e69de29..d95f3ad 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,3 +10,5 @@ function validateToken(token: string) {
+  if (!token) return false;
+  return token.startsWith("Bearer ");
 }
`

const SAMPLE_LCOV = `
SF:src/auth.ts
DA:10,5
DA:11,0
end_of_record
`

describe('Test Coverage Regression Auditor (EVIDENCE-003)', () => {
  it('parses standard LCOV output correctly', () => {
    const coverageMap = parseLcov(SAMPLE_LCOV)
    expect(coverageMap.size).toBe(1)
    const authCoverage = coverageMap.get('src/auth.ts')
    expect(authCoverage).toBeDefined()
    expect(authCoverage?.lines.get(10)).toBe(5)
    expect(authCoverage?.lines.get(11)).toBe(0)
  })

  it('extracts modified line numbers from unified diff hunks', () => {
    const modified = extractModifiedLineNumbers(SAMPLE_DIFF)
    expect(modified.size).toBe(1)
    const lines = modified.get('src/auth.ts')
    expect(lines).toEqual([10, 11])
  })

  it('audits changeset coverage and flags uncovered modified lines', () => {
    const coverageMap = parseLcov(SAMPLE_LCOV)
    // In SAMPLE_DIFF, lines 10 and 11 are modified. Line 10 is covered (5), line 11 is uncovered (0).
    // Coverage = 1/2 = 50%
    const report = auditChangesetCoverage(SAMPLE_DIFF, coverageMap, 80)

    expect(report.valid).toBe(true)
    expect(report.totalModifiedLines).toBe(2)
    expect(report.coveredModifiedLines).toBe(1)
    expect(report.overallModifiedCoveragePct).toBe(50)
    expect(report.meetsThreshold).toBe(false)
    expect(report.error).toContain('is below required minimum 80%')

    const fileReport = report.files[0]
    expect(fileReport?.filePath).toBe('src/auth.ts')
    expect(fileReport?.uncoveredModifiedLines).toEqual([11])
  })

  it('passes when coverage meets or exceeds threshold', () => {
    const fullyCoveredLcov = `
SF:src/auth.ts
DA:10,5
DA:11,3
end_of_record
`
    const coverageMap = parseLcov(fullyCoveredLcov)
    const report = auditChangesetCoverage(SAMPLE_DIFF, coverageMap, 80)

    expect(report.valid).toBe(true)
    expect(report.overallModifiedCoveragePct).toBe(100)
    expect(report.meetsThreshold).toBe(true)
    expect(report.error).toBeUndefined()
    expect(report.formattedSummary).toContain('Status: PASSED')
  })
})
