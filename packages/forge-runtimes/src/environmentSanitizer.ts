import { isSecretEnvName } from './process/redact'

export interface SanitizeEnvironmentOptions {
  readonly parentEnv?: Readonly<Record<string, string | undefined>> | undefined
  readonly extra?: Readonly<Record<string, string>> | undefined
  readonly allowlist?: readonly string[] | undefined
  readonly mode?: 'strict' | 'permissive' | undefined
  readonly context?:
    | {
        readonly runId?: string | undefined
        readonly stepId?: string | undefined
        readonly worktreePath?: string | undefined
        readonly dataDir?: string | undefined
        readonly runtimeId?: string | undefined
      }
    | undefined
}

export interface SanitizedEnvironmentReport {
  readonly mode: 'strict' | 'permissive'
  readonly env: Record<string, string>
  readonly preservedKeys: readonly string[]
  readonly withheldKeys: readonly string[]
  readonly injectedKeys: readonly string[]
  readonly formattedSummary: string
}

/** Standard safe host variables needed for standard binary execution across platforms. */
export const DEFAULT_ALLOWED_ENV_VARS: readonly string[] = [
  'PATH',
  'Path',
  'PATHEXT',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'ComSpec',
  'WINDIR',
  'windir',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
  'NODE_ENV',
]

/**
 * Builds a deterministic, sanitized environment for runtime and agent child processes.
 *
 * Implements Axiom A7 (Least privilege & sandboxing): Restricts child process environment
 * to explicitly whitelisted variables, strips host secrets, and injects execution context.
 */
export function sanitizeRuntimeEnvironment(
  options: SanitizeEnvironmentOptions = {},
): SanitizedEnvironmentReport {
  const parent = options.parentEnv ?? process.env
  const mode = options.mode ?? 'strict'
  const customAllowlist = new Set((options.allowlist ?? []).map((k) => k.toUpperCase()))
  const defaultAllowlist = new Set(DEFAULT_ALLOWED_ENV_VARS.map((k) => k.toUpperCase()))

  const env: Record<string, string> = {}
  const preservedKeys: string[] = []
  const withheldKeys: string[] = []
  const injectedKeys: string[] = []

  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue

    const upperKey = key.toUpperCase()

    // 1. Secret filter: if it matches a secret name pattern and is not explicitly in custom allowlist, withhold
    if (isSecretEnvName(key) && !customAllowlist.has(upperKey)) {
      withheldKeys.push(key)
      continue
    }

    // 2. Mode filter:
    if (mode === 'strict') {
      if (defaultAllowlist.has(upperKey) || customAllowlist.has(upperKey)) {
        env[key] = value
        preservedKeys.push(key)
      } else {
        withheldKeys.push(key)
      }
    } else {
      // Permissive mode passes all non-secret variables
      env[key] = value
      preservedKeys.push(key)
    }
  }

  // 3. Inject execution context
  if (options.context) {
    if (options.context.runId) {
      env.FORGE_RUN_ID = options.context.runId
      injectedKeys.push('FORGE_RUN_ID')
    }
    if (options.context.stepId) {
      env.FORGE_STEP_ID = options.context.stepId
      injectedKeys.push('FORGE_STEP_ID')
    }
    if (options.context.worktreePath) {
      env.FORGE_WORKTREE_PATH = options.context.worktreePath
      injectedKeys.push('FORGE_WORKTREE_PATH')
    }
    if (options.context.dataDir) {
      env.FORGE_DATA_DIR = options.context.dataDir
      injectedKeys.push('FORGE_DATA_DIR')
    }
    if (options.context.runtimeId) {
      env.FORGE_RUNTIME_ID = options.context.runtimeId
      injectedKeys.push('FORGE_RUNTIME_ID')
    }
  }

  // 4. Merge extra overrides
  if (options.extra) {
    for (const [key, val] of Object.entries(options.extra)) {
      env[key] = val
      if (!injectedKeys.includes(key)) {
        injectedKeys.push(key)
      }
    }
  }

  preservedKeys.sort()
  withheldKeys.sort()
  injectedKeys.sort()

  const lines: string[] = []
  lines.push('================================================================================')
  lines.push(`Runtime Environment Sandbox [Mode: ${mode.toUpperCase()}]`)
  lines.push(
    `Preserved: ${String(preservedKeys.length)} | Withheld: ${String(withheldKeys.length)} | Injected: ${String(injectedKeys.length)}`,
  )
  lines.push('================================================================================')
  if (withheldKeys.length > 0) {
    lines.push(`Withheld Keys (Stripped for Security):`)
    lines.push(`  ${withheldKeys.join(', ')}`)
  }
  if (injectedKeys.length > 0) {
    lines.push(`Injected Execution Context:`)
    lines.push(`  ${injectedKeys.join(', ')}`)
  }
  lines.push('================================================================================')

  return {
    mode,
    env,
    preservedKeys,
    withheldKeys,
    injectedKeys,
    formattedSummary: lines.join('\n'),
  }
}
