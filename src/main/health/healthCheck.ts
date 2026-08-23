import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface CheckItem {
  readonly ok: boolean
  readonly detail: string
}

export interface HealthCheckReport {
  readonly healthy: boolean
  readonly timestamp: string
  readonly checks: {
    readonly node: CheckItem
    readonly git: CheckItem
    readonly storage: CheckItem
  }
}

/**
 * Validates that the active Node.js runtime meets the required version (>= 22).
 */
export function checkNodeVersion(versionString: string = process.versions.node): CheckItem {
  const major = parseInt(versionString.split('.')[0] ?? '0', 10)
  if (major >= 22) {
    return { ok: true, detail: `Node.js v${versionString} (supported)` }
  }
  return { ok: false, detail: `Node.js v${versionString} (requires v22 or newer)` }
}

/**
 * Validates that Git is installed and discoverable on PATH.
 */
export function checkGitAvailable(
  runner: (cmd: string) => string = (cmd) =>
    execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }),
): CheckItem {
  try {
    const output = runner('git --version').trim()
    if (output.toLowerCase().includes('git version')) {
      return { ok: true, detail: output }
    }
    return { ok: false, detail: `Unexpected git output: ${output}` }
  } catch (err: unknown) {
    return {
      ok: false,
      detail: `Git is not installed or not discoverable on PATH: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Validates that the application data directory exists and is writable.
 */
export function checkStorageWritable(targetDir: string): CheckItem {
  try {
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true })
    }
    const testFile = join(targetDir, `.healthcheck-${String(Date.now())}.tmp`)
    writeFileSync(testFile, 'ok', 'utf8')
    rmSync(testFile, { force: true })
    return { ok: true, detail: `Storage directory writable at ${targetDir}` }
  } catch (err: unknown) {
    return {
      ok: false,
      detail: `Storage directory not writable (${targetDir}): ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Runs all first-run and startup health checks.
 */
export function runHealthChecks(dataDir: string): HealthCheckReport {
  const node = checkNodeVersion()
  const git = checkGitAvailable()
  const storage = checkStorageWritable(dataDir)

  const healthy = node.ok && git.ok && storage.ok

  return {
    healthy,
    timestamp: new Date().toISOString(),
    checks: {
      node,
      git,
      storage,
    },
  }
}
