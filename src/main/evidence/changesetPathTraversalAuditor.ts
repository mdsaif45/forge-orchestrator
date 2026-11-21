/**
 * EVIDENCE-018: Changeset Security Sandbox Escape & Path Traversal Static Auditor.
 *
 * Statically inspects changeset file paths and patch headers to detect and prevent
 * directory traversal escapes, absolute system targets, Windows UNC paths, and
 * forbidden file extension attacks outside the designated workspace sandbox.
 */

export type PathViolationSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM'

export interface PathViolation {
  filePath: string
  severity: PathViolationSeverity
  violationType:
    | 'DIRECTORY_TRAVERSAL'
    | 'ABSOLUTE_PATH_ESCAPE'
    | 'UNC_PATH_ESCAPE'
    | 'NULL_BYTE_INJECTION'
    | 'FORBIDDEN_EXTENSION'
    | 'RESTRICTED_DOTFILE'
  message: string
}

export interface PathTraversalAuditorOptions {
  workspaceRoot?: string
  forbiddenExtensions?: string[]
  allowHiddenDotfiles?: boolean
}

export interface PathSecurityAuditReport {
  isSafe: boolean
  totalFilesScanned: number
  violationCount: number
  violations: PathViolation[]
  highestSeverity?: PathViolationSeverity | undefined
  summary: string
}

const DEFAULT_FORBIDDEN_EXTENSIONS = [
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bat',
  '.cmd',
  '.ps1',
  '.com',
  '.vbs',
]

const RESTRICTED_DOTFILE_PATTERNS = [
  /^\.git\//i,
  /^\.ssh\//i,
  /^\.gnupg\//i,
  /^\.env/i,
  /^\.aws\//i,
]

export function auditChangesetPaths(
  filePaths: string[],
  options: PathTraversalAuditorOptions = {},
): PathSecurityAuditReport {
  const violations: PathViolation[] = []
  const forbiddenExts = (options.forbiddenExtensions ?? DEFAULT_FORBIDDEN_EXTENSIONS).map((ext) =>
    ext.toLowerCase(),
  )
  const allowDotfiles = options.allowHiddenDotfiles ?? false

  for (const rawPath of filePaths) {
    const trimmed = rawPath.trim()
    if (!trimmed) {
      continue
    }

    // 1. Null byte injection check
    if (trimmed.includes('\0') || trimmed.includes('%00')) {
      violations.push({
        filePath: trimmed,
        severity: 'CRITICAL',
        violationType: 'NULL_BYTE_INJECTION',
        message: `Null byte character detected in file path: "${trimmed}".`,
      })
      continue
    }

    // 2. Windows UNC escape check (\\host\share or //host/share)
    if (/^[\\/]{2}/.test(trimmed)) {
      violations.push({
        filePath: trimmed,
        severity: 'CRITICAL',
        violationType: 'UNC_PATH_ESCAPE',
        message: `Windows UNC network path escape detected: "${trimmed}".`,
      })
      continue
    }

    // 3. Absolute path escape check (/root or C:\ or d:/)
    if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
      violations.push({
        filePath: trimmed,
        severity: 'CRITICAL',
        violationType: 'ABSOLUTE_PATH_ESCAPE',
        message: `Absolute filesystem path escape detected: "${trimmed}".`,
      })
      continue
    }

    // 4. Directory traversal check (.. or ../ or ..\ or URL-encoded %2e%2e)
    const normalizedSeparators = trimmed.replace(/\\/g, '/')
    const segments = normalizedSeparators.split('/')

    let hasTraversal = false
    for (const segment of segments) {
      const lower = segment.toLowerCase()
      if (lower === '..' || lower === '%2e%2e' || lower === '..%2f') {
        hasTraversal = true
        break
      }
    }

    if (hasTraversal) {
      violations.push({
        filePath: trimmed,
        severity: 'CRITICAL',
        violationType: 'DIRECTORY_TRAVERSAL',
        message: `Directory traversal sequence ("..") detected in file path: "${trimmed}".`,
      })
      continue
    }

    // 5. Forbidden executable extension check
    const dotIdx = trimmed.lastIndexOf('.')
    if (dotIdx !== -1) {
      const ext = trimmed.slice(dotIdx).toLowerCase()
      if (forbiddenExts.includes(ext)) {
        violations.push({
          filePath: trimmed,
          severity: 'HIGH',
          violationType: 'FORBIDDEN_EXTENSION',
          message: `Forbidden executable file extension "${ext}" detected in changeset: "${trimmed}".`,
        })
        continue
      }
    }

    // 6. Restricted security dotfile check (.git/, .ssh/, .env)
    if (!allowDotfiles) {
      const normalizedPath = normalizedSeparators.replace(/^\.\//, '')
      for (const pattern of RESTRICTED_DOTFILE_PATTERNS) {
        if (pattern.test(normalizedPath)) {
          violations.push({
            filePath: trimmed,
            severity: 'MEDIUM',
            violationType: 'RESTRICTED_DOTFILE',
            message: `Modification to restricted configuration/credential dotfile detected: "${trimmed}".`,
          })
          break
        }
      }
    }
  }

  const isSafe = violations.length === 0
  let highestSeverity: PathViolationSeverity | undefined

  if (violations.some((v) => v.severity === 'CRITICAL')) {
    highestSeverity = 'CRITICAL'
  } else if (violations.some((v) => v.severity === 'HIGH')) {
    highestSeverity = 'HIGH'
  } else if (violations.some((v) => v.severity === 'MEDIUM')) {
    highestSeverity = 'MEDIUM'
  }

  const summary = isSafe
    ? `PATH SECURITY AUDIT PASSED: Scanned ${String(filePaths.length)} files with zero sandbox violations.`
    : `PATH SECURITY AUDIT FAILED: ${String(violations.length)} security violation(s) detected (Highest Severity: ${highestSeverity ?? 'NONE'}).`

  return {
    isSafe,
    totalFilesScanned: filePaths.length,
    violationCount: violations.length,
    violations,
    highestSeverity,
    summary,
  }
}
