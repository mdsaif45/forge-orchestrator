import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ArtifactId, ArtifactMetadata, RunId } from '@shared/domain'
import type { ArtifactService } from '../artifacts'
import type { ArtifactStore } from '../db/artifactStore'
import { auditDiffSecurity, auditRunChangesetSecurity } from './securityAuditor'

describe('securityAuditor', () => {
  it('reports clean when diff contains normal source code changes', () => {
    const cleanDiff = `
diff --git a/src/index.ts b/src/index.ts
index e69de29..4995346 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,5 @@
+export function add(a: number, b: number): number {
+  return a + b
+}
`
    const report = auditDiffSecurity(cleanDiff)
    expect(report.clean).toBe(true)
    expect(report.totalViolations).toBe(0)
    expect(report.criticalCount).toBe(0)
    expect(report.scannedFiles).toContain('src/index.ts')
  })

  it('detects forbidden file commit (.env)', () => {
    const envDiff = `
diff --git a/.env b/.env
new file mode 100644
index 0000000..8a3c89b
--- /dev/null
+++ b/.env
@@ -0,0 +1,2 @@
+DATABASE_URL=postgres://localhost/db
`
    const report = auditDiffSecurity(envDiff)
    expect(report.clean).toBe(false)
    expect(report.criticalCount).toBeGreaterThan(0)
    expect(report.violations.some((v) => v.ruleId === 'SEC-FILE-001')).toBe(true)
  })

  it('detects AWS access key and private key additions in diff lines', () => {
    const secretDiff = `
diff --git a/config.ts b/config.ts
--- a/config.ts
+++ b/config.ts
@@ -5,2 +5,4 @@
+const awsKey = "AKIAIOSFODNN7EXAMPLE";
+const privKey = "-----BEGIN RSA PRIVATE KEY-----";
`
    const report = auditDiffSecurity(secretDiff)
    expect(report.clean).toBe(false)
    expect(report.criticalCount).toBe(2)
    expect(report.violations.some((v) => v.ruleId === 'SEC-AWS-001')).toBe(true)
    expect(report.violations.some((v) => v.ruleId === 'SEC-KEY-001')).toBe(true)
    expect(report.violations[0]?.redactedSample).toContain('...')
  })

  it('detects hardcoded database credentials in connection URI', () => {
    const uriDiff = `
diff --git a/app.ts b/app.ts
--- a/app.ts
+++ b/app.ts
@@ -10,1 +10,1 @@
+const url = "postgres://admin:SuperSecretPass123@db.prod.internal:5432/main";
`
    const report = auditDiffSecurity(uriDiff)
    expect(report.clean).toBe(false)
    expect(report.violations.some((v) => v.ruleId === 'SEC-CONN-001')).toBe(true)
  })

  it('authoritatively audits recorded diff artifact from ArtifactStore and ArtifactService', async () => {
    const runId = randomUUID() as RunId
    const artId = randomUUID() as ArtifactId

    const mockArtifact: ArtifactMetadata = {
      id: artId,
      runId,
      stepId: null,
      relativePath: 'diff.patch',
      kind: 'diff',
      name: 'diff.patch',
      mimeType: 'text/plain',
      sizeBytes: 100,
      sha256: 'abc',
      createdAt: new Date().toISOString(),
    }

    const artifactStore = {
      listForRun: vi.fn().mockReturnValue([mockArtifact]),
    } as unknown as ArtifactStore

    const artifactService = {
      readArtifactText: vi.fn().mockResolvedValue(`
diff --git a/secrets.ts b/secrets.ts
--- a/secrets.ts
+++ b/secrets.ts
@@ -1,1 +1,2 @@
+const token = "ghp_123456789012345678901234567890123456";
`),
    } as unknown as ArtifactService

    const report = await auditRunChangesetSecurity(artifactService, artifactStore, runId)
    expect(report.clean).toBe(false)
    expect(report.criticalCount).toBe(1)
    expect(report.violations[0]?.ruleId).toBe('SEC-GH-001')
  })
})
