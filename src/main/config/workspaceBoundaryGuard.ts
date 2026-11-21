/**
 * CONFIG-014: Workspace security sandboxing policy validator and boundary guard.
 * Enforces least privilege, containment, and protected path shielding (Axioms A2, A7).
 */

import path from 'node:path'

export type BoundaryViolationKind =
  'traversal_escape' | 'protected_directory' | 'system_path' | 'none'

export interface BoundaryCheckResult {
  readonly allowed: boolean
  readonly targetPath: string
  readonly resolvedPath: string
  readonly violationKind: BoundaryViolationKind
  readonly reason?: string | undefined
  readonly formattedSummary: string
}

const PROTECTED_DIR_PATTERNS = [
  /^\.git(\/|\\|$)/i,
  /^\.env(\.|$)/i,
  /^\.ssh(\/|\\|$)/i,
  /^\.aws(\/|\\|$)/i,
  /^\.forge\/private(\/|\\|$)/i,
]

const DANGEROUS_SYSTEM_PATTERNS = [
  /^[a-zA-Z]:[/\\]windows([/\\]|$)/i,
  /^[a-zA-Z]:[/\\]program files([/\\]|$)/i,
  /^\/(etc|var|proc|sys|usr|bin|sbin)(\/|$)/i,
]

function isWindowsStylePath(p: string): boolean {
  return /^[a-zA-Z]:[/\\]/.test(p) || p.includes('\\')
}

function isPosixAbsolutePath(p: string): boolean {
  return p.startsWith('/')
}

function isWindowsAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[/\\]/.test(p) || /^\\\\[^\\]/.test(p)
}

/**
 * Validates whether a file path or directory access stays within workspace sandbox boundaries.
 */
export function validateWorkspaceBoundary(
  targetPath: string,
  workspaceRoot = process.cwd(),
): BoundaryCheckResult {
  if (!targetPath || targetPath.trim() === '') {
    return {
      allowed: false,
      targetPath,
      resolvedPath: '',
      violationKind: 'traversal_escape',
      reason: 'Target path cannot be empty or whitespace only.',
      formattedSummary: '✗ [BOUNDARY BLOCKED] Empty path is not permitted.',
    }
  }

  // Cross-system root mismatch: Windows absolute target on POSIX root or vice-versa
  if (
    (isWindowsAbsolutePath(targetPath) && isPosixAbsolutePath(workspaceRoot)) ||
    (isPosixAbsolutePath(targetPath) && isWindowsAbsolutePath(workspaceRoot))
  ) {
    const reason = `Path "${targetPath}" escapes workspace boundary "${workspaceRoot}".`
    return {
      allowed: false,
      targetPath,
      resolvedPath: targetPath,
      violationKind: 'traversal_escape',
      reason,
      formattedSummary: `✗ [BOUNDARY BLOCKED] Traversal violation: ${reason}`,
    }
  }

  const useWin32 =
    isWindowsStylePath(targetPath) ||
    isWindowsStylePath(workspaceRoot) ||
    process.platform === 'win32'
  const p = useWin32 ? path.win32 : path.posix

  const rootNormalized = p.resolve(workspaceRoot)
  const resolved = p.isAbsolute(targetPath)
    ? p.resolve(targetPath)
    : p.resolve(rootNormalized, targetPath)

  // Check 1: Traversal escape outside workspace root
  const rel = p.relative(rootNormalized, resolved)
  const escapesRoot = rel.startsWith('..') || p.isAbsolute(rel)

  if (escapesRoot) {
    const reason = `Path "${targetPath}" escapes workspace boundary "${rootNormalized}".`
    return {
      allowed: false,
      targetPath,
      resolvedPath: resolved,
      violationKind: 'traversal_escape',
      reason,
      formattedSummary: `✗ [BOUNDARY BLOCKED] Traversal violation: ${reason}`,
    }
  }

  // Check 2: Dangerous system directories
  for (const sysPattern of DANGEROUS_SYSTEM_PATTERNS) {
    if (sysPattern.test(resolved) || sysPattern.test(p.normalize(targetPath))) {
      const reason = `Access to critical operating system directory is prohibited.`
      return {
        allowed: false,
        targetPath,
        resolvedPath: resolved,
        violationKind: 'system_path',
        reason,
        formattedSummary: `✗ [BOUNDARY BLOCKED] System path prohibited: ${resolved}`,
      }
    }
  }

  // Check 3: Protected sensitive directories within workspace
  const cleanRel = rel.replace(/\\/g, '/')
  for (const pattern of PROTECTED_DIR_PATTERNS) {
    if (pattern.test(cleanRel)) {
      const reason = `Access to sensitive repository metadata directory "${cleanRel}" is forbidden.`
      return {
        allowed: false,
        targetPath,
        resolvedPath: resolved,
        violationKind: 'protected_directory',
        reason,
        formattedSummary: `✗ [BOUNDARY BLOCKED] Protected directory: ${reason}`,
      }
    }
  }

  return {
    allowed: true,
    targetPath,
    resolvedPath: resolved,
    violationKind: 'none',
    formattedSummary: `✓ [BOUNDARY ALLOWED] "${targetPath}" safely contained within workspace.`,
  }
}

/**
 * Asserts workspace boundary containment; throws Error on violation.
 */
export function assertWorkspaceBoundary(targetPath: string, workspaceRoot = process.cwd()): void {
  const result = validateWorkspaceBoundary(targetPath, workspaceRoot)
  if (!result.allowed) {
    throw new Error(result.reason ?? 'Workspace boundary containment check failed.')
  }
}
