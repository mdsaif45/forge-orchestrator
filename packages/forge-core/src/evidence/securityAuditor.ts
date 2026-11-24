import { runIdSchema, type ArtifactMetadata, type RunId } from '@shared/domain'
import type { ArtifactService } from '../artifacts'
import type { ArtifactStore } from '../db/artifactStore'

export type SecurityViolationSeverity = 'critical' | 'warning'

export interface SecurityViolation {
  readonly file: string
  readonly line?: number | undefined
  readonly ruleId: string
  readonly severity: SecurityViolationSeverity
  readonly message: string
  readonly redactedSample: string
}

export interface SecurityAuditReport {
  readonly clean: boolean
  readonly totalViolations: number
  readonly criticalCount: number
  readonly warningCount: number
  readonly violations: readonly SecurityViolation[]
  readonly scannedFiles: readonly string[]
  readonly formattedSummary: string
  readonly error?: string | undefined
}

export interface SecurityAuditOptions {
  readonly maxViolations?: number | undefined
}

const FORBIDDEN_FILE_PATTERNS: readonly {
  readonly pattern: RegExp
  readonly ruleId: string
  readonly message: string
}[] = [
  {
    pattern: /(^|\/)\.env(\.[a-zA-Z0-9_-]+)?$/i,
    ruleId: 'SEC-FILE-001',
    message: 'Prohibited environment configuration file committing secrets',
  },
  {
    pattern: /\.(pem|key|pkcs12|pfx)$/i,
    ruleId: 'SEC-FILE-002',
    message: 'Prohibited cryptographic certificate or private key file',
  },
  {
    pattern: /(^|\/)(id_rsa|id_ed25519|id_dsa)$/i,
    ruleId: 'SEC-FILE-003',
    message: 'Prohibited SSH private key file',
  },
  {
    pattern: /(^|\/)service-account(\.[a-zA-Z0-9_-]+)?\.json$/i,
    ruleId: 'SEC-FILE-004',
    message: 'Prohibited cloud service account credentials file',
  },
]

const SECRET_CONTENT_RULES: readonly {
  readonly pattern: RegExp
  readonly ruleId: string
  readonly severity: SecurityViolationSeverity
  readonly message: string
}[] = [
  {
    pattern: /-----BEGIN\s+(?:[A-Z0-9_-]+\s+)?PRIVATE\s+KEY-----/,
    ruleId: 'SEC-KEY-001',
    severity: 'critical',
    message: 'Unencrypted private key block detected in diff addition',
  },
  {
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    ruleId: 'SEC-AWS-001',
    severity: 'critical',
    message: 'AWS Access Key ID detected in diff addition',
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/,
    ruleId: 'SEC-GH-001',
    severity: 'critical',
    message: 'GitHub Personal Access Token detected in diff addition',
  },
  {
    pattern: /(?:(?:postgres|mysql|mongodb|redis|amqp):\/\/[a-zA-Z0-9_]+:)([^@\s/]+)@/i,
    ruleId: 'SEC-CONN-001',
    severity: 'critical',
    message: 'Database connection URI containing hardcoded credentials',
  },
  {
    pattern:
      /(?:api[_-]?key|secret[_-]?key|auth[_-]?token|bearer)\s*[:=]\s*["']([A-Za-z0-9_-]{24,})["']/i,
    ruleId: 'SEC-TOKEN-001',
    severity: 'warning',
    message: 'Hardcoded API key or authorization token assignment',
  },
]

function redactMatchedString(str: string): string {
  if (str.length <= 8) return '***'
  return `${str.slice(0, 3)}...${str.slice(-3)}`
}

/**
 * Scans unified git diff patches for committed credentials, private keys, and forbidden files.
 *
 * Implements Axioms:
 * - A2 (Fail-closed): Returns clean: false on any critical security violation.
 * - A7 (Least privilege & security sandboxing): Prevents accidental credential leaks in repo changesets.
 */
export function auditDiffSecurity(
  diffText: string,
  options: SecurityAuditOptions = {},
): SecurityAuditReport {
  if (!diffText.trim()) {
    return {
      clean: true,
      totalViolations: 0,
      criticalCount: 0,
      warningCount: 0,
      violations: [],
      scannedFiles: [],
      formattedSummary: 'Changeset is clean: 0 files modified or empty diff.',
    }
  }

  const violations: SecurityViolation[] = []
  const scannedFiles = new Set<string>()
  const maxViolations = options.maxViolations ?? 100

  const lines = diffText.split(/\r?\n/)
  let currentFile = 'unknown'
  let inHunk = false
  let lineCounter = 0

  for (const line of lines) {
    if (violations.length >= maxViolations) break

    if (line.startsWith('diff --git ')) {
      inHunk = false
      const parts = line.split(' ')
      const bPath = parts[3] ?? parts[2] ?? ''
      currentFile = bPath.replace(/^[a-b]\//, '')
      scannedFiles.add(currentFile)

      // Check forbidden file rules
      for (const rule of FORBIDDEN_FILE_PATTERNS) {
        if (rule.pattern.test(currentFile)) {
          violations.push({
            file: currentFile,
            ruleId: rule.ruleId,
            severity: 'critical',
            message: rule.message,
            redactedSample: currentFile,
          })
        }
      }
      continue
    }

    if (line.startsWith('@@ ')) {
      inHunk = true
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      lineCounter = match ? parseInt(match[1] ?? '1', 10) : 1
      continue
    }

    if (inHunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        const addedContent = line.slice(1)

        // Scan added line for security rules
        for (const rule of SECRET_CONTENT_RULES) {
          const match = rule.pattern.exec(addedContent)
          if (match) {
            violations.push({
              file: currentFile,
              line: lineCounter,
              ruleId: rule.ruleId,
              severity: rule.severity,
              message: rule.message,
              redactedSample: redactMatchedString(match[0]),
            })
          }
        }
        lineCounter++
      } else if (!line.startsWith('-')) {
        lineCounter++
      }
    }
  }

  const criticalCount = violations.filter((v) => v.severity === 'critical').length
  const warningCount = violations.filter((v) => v.severity === 'warning').length
  const clean = criticalCount === 0

  const summaryLines: string[] = []
  summaryLines.push(
    '================================================================================',
  )
  summaryLines.push(
    `Changeset Security Audit: ${clean ? 'PASSED' : 'FAILED (Violations Detected)'}`,
  )
  summaryLines.push(
    `Scanned Files: ${String(scannedFiles.size)} | Critical: ${String(criticalCount)} | Warnings: ${String(warningCount)}`,
  )
  summaryLines.push(
    '================================================================================',
  )
  for (const v of violations) {
    const sev = v.severity.toUpperCase().padEnd(8)
    const loc = v.line ? `${v.file}:${String(v.line)}` : v.file
    summaryLines.push(`  [${sev}] [${v.ruleId}] ${loc}`)
    summaryLines.push(`    Reason: ${v.message}`)
    summaryLines.push(`    Sample: ${v.redactedSample}`)
  }
  summaryLines.push(
    '================================================================================',
  )

  return {
    clean,
    totalViolations: violations.length,
    criticalCount,
    warningCount,
    violations,
    scannedFiles: [...scannedFiles],
    formattedSummary: summaryLines.join('\n'),
  }
}

/**
 * Authoritatively audits the physical changeset diff artifacts recorded for a run.
 */
export async function auditRunChangesetSecurity(
  artifactService: ArtifactService,
  artifactStore: ArtifactStore,
  rawRunId: string,
  stepId?: string,
): Promise<SecurityAuditReport> {
  const parsedRunId = runIdSchema.safeParse(rawRunId)
  if (!parsedRunId.success) {
    return {
      clean: false,
      totalViolations: 0,
      criticalCount: 0,
      warningCount: 0,
      violations: [],
      scannedFiles: [],
      formattedSummary: `Invalid runId: ${rawRunId}`,
      error: `Invalid runId format: ${rawRunId}`,
    }
  }

  const runId: RunId = parsedRunId.data
  const artifacts: readonly ArtifactMetadata[] = artifactStore.listForRun(runId)

  let filtered = artifacts
  if (stepId) {
    filtered = filtered.filter((a) => a.stepId === stepId)
  }

  const diffArtifact =
    filtered.find((a) => a.kind === 'changeset' || a.kind === 'diff') ??
    artifacts.find((a) => a.kind === 'changeset' || a.kind === 'diff')

  if (!diffArtifact) {
    return {
      clean: true,
      totalViolations: 0,
      criticalCount: 0,
      warningCount: 0,
      violations: [],
      scannedFiles: [],
      formattedSummary: `No changeset or diff artifacts found for run ${runId}; nothing to audit.`,
    }
  }

  const rawDiff = await artifactService.readArtifactText(diffArtifact.id)
  return auditDiffSecurity(rawDiff)
}
