import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { ForgeConfig } from './forgeConfig'
import { runGit } from '../git/exec'

export type CheckStatus = 'ok' | 'warning' | 'error'

export interface DoctorCheck {
  readonly id: string
  readonly title: string
  readonly status: CheckStatus
  readonly message: string
  readonly remedy?: string | undefined
}

export interface ForgeDoctorReport {
  readonly healthy: boolean
  readonly timestamp: string
  readonly checks: readonly DoctorCheck[]
  readonly errorCount: number
  readonly warningCount: number
  readonly formattedSummary: string
}

export interface AuditDoctorOptions {
  readonly dataDir: string
  readonly sqlite: Database.Database
  readonly config?: ForgeConfig | undefined
  readonly configPath?: string | undefined
  readonly providerEndpoint?: string | undefined
  readonly timeoutMs?: number | undefined
}

/**
 * Diagnostic health auditor for Forge runtime, storage, database, git, and provider layers.
 *
 * Implements Axiom A2: Reports structural defects and failures explicitly with remedies.
 */
export async function auditForgeEnvironment(
  options: AuditDoctorOptions,
): Promise<ForgeDoctorReport> {
  const checks: DoctorCheck[] = []

  // 1. Configuration check
  if (options.configPath && existsSync(options.configPath)) {
    if (options.config?.activeProfile) {
      const active = options.config.activeProfile
      if (active !== 'default' && !options.config.profiles?.[active]) {
        checks.push({
          id: 'config.profile',
          title: 'Active Configuration Profile',
          status: 'warning',
          message: `Active profile "${active}" is not defined in profiles map`,
          remedy: `Run 'forge config profile use <valid-profile>' or update ${options.configPath}`,
        })
      } else {
        checks.push({
          id: 'config.profile',
          title: 'Active Configuration Profile',
          status: 'ok',
          message: `Active profile: ${active}`,
        })
      }
    } else {
      checks.push({
        id: 'config.file',
        title: 'Configuration File',
        status: 'ok',
        message: `Loaded valid configuration from ${options.configPath}`,
      })
    }
  } else {
    checks.push({
      id: 'config.file',
      title: 'Configuration File',
      status: 'warning',
      message: 'No .forgerc file detected; using default built-in configuration',
      remedy: "Run 'forge config set' or create a .forgerc in project root or home directory",
    })
  }

  // 2. Data directory write test
  try {
    const probeFile = join(options.dataDir, `.doctor-probe-${String(Date.now())}.tmp`)
    await writeFile(probeFile, 'ok', 'utf8')
    await rm(probeFile, { force: true })
    checks.push({
      id: 'storage.dataDir',
      title: 'Data Directory Access',
      status: 'ok',
      message: `Read/write verified at ${options.dataDir}`,
    })
  } catch (err) {
    checks.push({
      id: 'storage.dataDir',
      title: 'Data Directory Access',
      status: 'error',
      message: `Failed writing to dataDir (${options.dataDir}): ${err instanceof Error ? err.message : String(err)}`,
      remedy: `Verify directory permissions for ${options.dataDir}`,
    })
  }

  // 3. Artifacts directory check
  const artifactsDir = join(options.dataDir, 'artifacts')
  if (existsSync(artifactsDir)) {
    checks.push({
      id: 'storage.artifactsDir',
      title: 'Artifacts Storage Directory',
      status: 'ok',
      message: `Artifacts storage active at ${artifactsDir}`,
    })
  } else {
    checks.push({
      id: 'storage.artifactsDir',
      title: 'Artifacts Storage Directory',
      status: 'ok',
      message: `Artifacts storage directory will be created lazily at ${artifactsDir}`,
    })
  }

  // 4. Database integrity checks
  try {
    const integrity = options.sqlite.pragma('integrity_check', { simple: true })
    if (integrity === 'ok') {
      checks.push({
        id: 'database.integrity',
        title: 'SQLite Database Integrity',
        status: 'ok',
        message: 'PRAGMA integrity_check passed (ok)',
      })
    } else {
      checks.push({
        id: 'database.integrity',
        title: 'SQLite Database Integrity',
        status: 'error',
        message: `Database corruption detected: ${String(integrity)}`,
        remedy: "Run 'forge db vacuum' or restore database from backup",
      })
    }

    const fkChecks = options.sqlite.pragma('foreign_key_check') as unknown[]
    if (Array.isArray(fkChecks) && fkChecks.length === 0) {
      checks.push({
        id: 'database.foreignKeys',
        title: 'SQLite Foreign Key Constraints',
        status: 'ok',
        message: 'All foreign key constraints verified (0 violations)',
      })
    } else {
      checks.push({
        id: 'database.foreignKeys',
        title: 'SQLite Foreign Key Constraints',
        status: 'warning',
        message: `${String(Array.isArray(fkChecks) ? fkChecks.length : 1)} foreign key reference violations found`,
        remedy: 'Database contains dangling references; inspect orphaned run records',
      })
    }
  } catch (err) {
    checks.push({
      id: 'database.check',
      title: 'SQLite Database Checks',
      status: 'error',
      message: `Database check failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  // 5. Git CLI availability check
  try {
    const gitRes = await runGit(['--version'], { cwd: process.cwd() })
    checks.push({
      id: 'git.binary',
      title: 'Git Binary & CLI',
      status: 'ok',
      message: gitRes.stdout.trim(),
    })
  } catch (err) {
    checks.push({
      id: 'git.binary',
      title: 'Git Binary & CLI',
      status: 'error',
      message: `Git binary check failed: ${err instanceof Error ? err.message : String(err)}`,
      remedy: 'Install git and ensure it is available in system PATH',
    })
  }

  // 6. Provider endpoint reachability (Ollama)
  const endpoint = options.providerEndpoint ?? 'http://127.0.0.1:11434'
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, options.timeoutMs ?? 1500)

    const res = await fetch(`${endpoint}/api/tags`, { signal: controller.signal })
    clearTimeout(timer)

    if (res.ok) {
      const data = (await res.json()) as { models?: unknown[] }
      const modelCount = Array.isArray(data.models) ? data.models.length : 0
      checks.push({
        id: 'provider.ollama',
        title: 'AI Provider Endpoint (Ollama)',
        status: 'ok',
        message: `Endpoint ${endpoint} reachable (${String(modelCount)} models installed)`,
      })
    } else {
      checks.push({
        id: 'provider.ollama',
        title: 'AI Provider Endpoint (Ollama)',
        status: 'warning',
        message: `Endpoint ${endpoint} responded with status ${String(res.status)}`,
        remedy: 'Ensure Ollama daemon is running and responsive',
      })
    }
  } catch {
    checks.push({
      id: 'provider.ollama',
      title: 'AI Provider Endpoint (Ollama)',
      status: 'warning',
      message: `Endpoint ${endpoint} unreachable (daemon offline)`,
      remedy: `Run 'ollama serve' or configure provider in .forgerc`,
    })
  }

  const errorCount = checks.filter((c) => c.status === 'error').length
  const warningCount = checks.filter((c) => c.status === 'warning').length
  const healthy = errorCount === 0

  const lines: string[] = []
  lines.push('================================================================================')
  lines.push(`Forge Environment Doctor: ${healthy ? 'HEALTHY' : 'ISSUES DETECTED'}`)
  lines.push(
    `Total Checks: ${String(checks.length)} | Errors: ${String(errorCount)} | Warnings: ${String(warningCount)}`,
  )
  lines.push('================================================================================')
  for (const c of checks) {
    const tag = `[${c.status.toUpperCase()}]`.padEnd(10)
    lines.push(`  ${tag} ${c.title.padEnd(30)} ${c.message}`)
    if (c.remedy) {
      lines.push(`             -> Remedy: ${c.remedy}`)
    }
  }
  lines.push('================================================================================')

  return {
    healthy,
    timestamp: new Date().toISOString(),
    checks,
    errorCount,
    warningCount,
    formattedSummary: lines.join('\n'),
  }
}
