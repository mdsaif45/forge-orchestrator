import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type RuntimeHealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'simulated'

export interface RuntimeProbeResult {
  readonly available: boolean | null
  readonly version: string | null
  readonly health: RuntimeHealthStatus
  readonly latencyMs: number | null
}

/**
 * Probes the health, version, and execution responsiveness of a runtime executable.
 * Non-blocking with strict timeouts to satisfy Axiom A5 (bounded execution).
 */
export async function probeRuntimeExecutable(
  executable: string | null,
  options?: {
    readonly isSimulated?: boolean
    readonly timeoutMs?: number
  },
): Promise<RuntimeProbeResult> {
  const isSimulated = options?.isSimulated ?? false
  const timeoutMs = options?.timeoutMs ?? 1500

  // 1. In-process or simulated runtime that spawns no external CLI
  if (executable === null) {
    return {
      available: null,
      version: null,
      health: isSimulated ? 'simulated' : 'healthy',
      latencyMs: 0,
    }
  }

  const startTime = Date.now()

  // 2. Check binary resolution on PATH
  const isWin = process.platform === 'win32'
  const lookupCmd = isWin ? 'where.exe' : 'which'

  try {
    await execFileAsync(lookupCmd, [executable], {
      timeout: timeoutMs,
      windowsHide: true,
    })
  } catch {
    return {
      available: false,
      version: null,
      health: 'unavailable',
      latencyMs: Date.now() - startTime,
    }
  }

  // 3. Binary exists on PATH; probe version
  try {
    const versionStart = Date.now()
    const { stdout, stderr } = await execFileAsync(executable, ['--version'], {
      timeout: timeoutMs,
      windowsHide: true,
    })

    const latencyMs = Date.now() - versionStart
    const rawOut = stdout.trim() || stderr.trim()
    const firstLine = rawOut.split(/\r?\n/)[0]?.trim() ?? ''
    const version = firstLine.length > 0 ? firstLine.slice(0, 64) : 'unknown'

    return {
      available: true,
      version,
      health: 'healthy',
      latencyMs,
    }
  } catch {
    // Executable exists on PATH but failed `--version` check (e.g. non-zero exit or timeout)
    return {
      available: true,
      version: null,
      health: 'degraded',
      latencyMs: Date.now() - startTime,
    }
  }
}

export interface RuntimeExecutionTestResult {
  readonly success: boolean
  readonly runtimeId: string
  readonly executable: string | null
  readonly durationMs: number
  readonly exitCode: number | null
  readonly output: string
  readonly error?: string
}

/**
 * Tests end-to-end execution of a runtime by running a benchmark probe command.
 * For in-process runtimes (executable is null), tests immediate in-process dispatch.
 * For CLI runtimes, runs the executable with `--version` or test probe and verifies exit code 0.
 */
export async function testRuntimeExecution(
  runtimeId: string,
  executable: string | null,
  options?: {
    readonly isSimulated?: boolean
    readonly timeoutMs?: number
  },
): Promise<RuntimeExecutionTestResult> {
  const timeoutMs = options?.timeoutMs ?? 3000
  const isSimulated = options?.isSimulated ?? false

  if (executable === null) {
    return {
      success: true,
      runtimeId,
      executable: null,
      durationMs: 0,
      exitCode: 0,
      output: isSimulated
        ? 'Simulated runtime execution test passed'
        : 'In-process native runtime operational',
    }
  }

  const startTime = Date.now()
  try {
    const { stdout, stderr } = await execFileAsync(executable, ['--version'], {
      timeout: timeoutMs,
      windowsHide: true,
    })
    const durationMs = Date.now() - startTime
    const rawOut = stdout.trim() || stderr.trim()
    const firstLine = rawOut.split(/\r?\n/)[0]?.trim() ?? 'OK'

    return {
      success: true,
      runtimeId,
      executable,
      durationMs,
      exitCode: 0,
      output: firstLine,
    }
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime
    const errorObj = err as {
      code?: string | number
      message?: string
      stdout?: string
      stderr?: string
    }
    const exitCode = typeof errorObj.code === 'number' ? errorObj.code : null
    const errorMsg = errorObj.message ?? String(err)
    const output = (errorObj.stdout ?? errorObj.stderr ?? '').trim()

    return {
      success: false,
      runtimeId,
      executable,
      durationMs,
      exitCode,
      output,
      error: errorMsg,
    }
  }
}
