import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { capabilitySchema } from '@shared/domain'

/**
 * Schema for a user-configured custom CLI runtime entry in `.forgerc`.
 */
export const customRuntimeConfigSchema = z.strictObject({
  /** Runtime identifier, conventionally prefixed with `custom:`. */
  id: z.string().min(1),
  /** Human-readable display name. */
  name: z.string().min(1),
  /** Executable binary or command name (e.g. `aider`, `opencode`). */
  command: z.string().min(1),
  /**
   * Command line arguments template.
   * Special tokens such as `{{prompt}}`, `{{workspace}}`, `{{role}}` are interpolated at runtime.
   */
  argsTemplate: z.array(z.string()).readonly().optional(),
  /** Custom environment variables passed to the child process. */
  env: z.record(z.string(), z.string()).readonly().optional(),
  /** Declared capabilities for role compatibility checking. */
  capabilities: z.array(capabilitySchema).readonly().optional(),
  /** Instruction filenames to search and inject (defaults to `['instructions.md', 'CLAUDE.md', 'AGENTS.md']`). */
  instructionFilenames: z.array(z.string()).readonly().optional(),
})

export type CustomRuntimeConfig = z.infer<typeof customRuntimeConfigSchema>

/**
 * Schema for profile-level configuration overrides.
 */
export const forgeProfileSchema = z.strictObject({
  dataDir: z.string().optional(),
  defaultRuntime: z.string().optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  telemetry: z.boolean().optional(),
  security: z
    .strictObject({
      allowExecutionOutsideWorkspace: z.boolean().optional(),
      maxExecutionTimeMs: z.number().int().positive().optional(),
    })
    .optional(),
  customRuntimes: z.array(customRuntimeConfigSchema).readonly().optional(),
  providers: z
    .record(
      z.string(),
      z.strictObject({
        endpoint: z.string().optional(),
        model: z.string().optional(),
        apiKeyEnv: z.string().optional(),
      }),
    )
    .optional(),
})

export type ForgeProfile = z.infer<typeof forgeProfileSchema>

/**
 * Top-level configuration schema for `.forgerc` and `.forgerc.json`.
 */
export const forgeConfigSchema = z.strictObject({
  /** Base data storage directory. Overridden by FORGE_DATA_DIR. */
  dataDir: z.string().optional(),
  /** Default runtime ID to use for tasks and workflows. */
  defaultRuntime: z.string().optional(),
  /** Application log level. */
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  /** Whether anonymous telemetry or metrics collection is enabled. */
  telemetry: z.boolean().optional(),
  /** Currently active environment profile name. */
  activeProfile: z.string().optional(),
  /** Multi-environment configuration profiles. */
  profiles: z.record(z.string(), forgeProfileSchema).optional(),
  /** Security and execution sandbox policies. */
  security: z
    .strictObject({
      allowExecutionOutsideWorkspace: z.boolean().optional(),
      maxExecutionTimeMs: z.number().int().positive().optional(),
    })
    .optional(),
  /** Custom data-driven CLI runtimes registered at startup. */
  customRuntimes: z.array(customRuntimeConfigSchema).readonly().optional(),
  /** Model provider settings and endpoints. */
  providers: z
    .record(
      z.string(),
      z.strictObject({
        endpoint: z.string().optional(),
        model: z.string().optional(),
        apiKeyEnv: z.string().optional(),
      }),
    )
    .optional(),
})

export type ForgeConfig = z.infer<typeof forgeConfigSchema>

export interface LoadForgeConfigOptions {
  /** Directory to start searching for `.forgerc` upwards. */
  readonly searchFrom?: string | undefined
  /** Explicit config file path (e.g. from `--config`). */
  readonly explicitPath?: string | undefined
  /** Explicit profile name to activate (overrides activeProfile and FORGE_PROFILE). */
  readonly profile?: string | undefined
  /** Environment variables dictionary (defaults to `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

const CONFIG_FILENAMES = ['.forgerc', '.forgerc.json', 'forge.config.json'] as const

/**
 * Searches for a Forge configuration file.
 *
 * Precedence:
 * 1. Explicit path if provided.
 * 2. `FORGE_CONFIG` environment variable.
 * 3. Traversing upwards from `searchFrom` directory to repository/filesystem root.
 * 4. User's home directory (`~/.forgerc` or `~/.forgerc.json`).
 */
export function findForgeConfigFile(
  searchFrom?: string,
  explicitPath?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (explicitPath !== undefined && explicitPath.trim() !== '') {
    const resolved = resolve(explicitPath)
    return existsSync(resolved) ? resolved : null
  }

  const envConfig = env.FORGE_CONFIG
  if (envConfig !== undefined && envConfig.trim() !== '') {
    const resolved = resolve(envConfig)
    return existsSync(resolved) ? resolved : null
  }

  // Search upwards from searchFrom directory
  let currentDir = resolve(searchFrom ?? process.cwd())
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(currentDir, name)
      if (existsSync(candidate)) {
        return candidate
      }
    }
    const parent = dirname(currentDir)
    if (parent === currentDir) {
      break
    }
    currentDir = parent
  }

  // Check home directory
  const home = homedir()
  for (const name of CONFIG_FILENAMES) {
    const homeCandidate = join(home, name)
    if (existsSync(homeCandidate)) {
      return homeCandidate
    }
  }

  return null
}

/**
 * Strips comments from JSONC-style configuration content before parsing.
 */
function stripJsonComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .trim()
}

/**
 * Merges profile overrides onto a base ForgeConfig object.
 */
export function applyProfileOverrides(base: ForgeConfig, profile: ForgeProfile): ForgeConfig {
  const merged: ForgeConfig = {
    ...base,
    ...profile,
    security: profile.security ? { ...base.security, ...profile.security } : base.security,
    providers: profile.providers ? { ...base.providers, ...profile.providers } : base.providers,
    customRuntimes: profile.customRuntimes ?? base.customRuntimes,
  }
  return merged
}

/**
 * Loads, parses, validates, and resolves Forge configuration.
 * Automatically merges active profile overrides and environment variables.
 */
export function loadForgeConfig(options?: LoadForgeConfigOptions): ForgeConfig {
  const env = options?.env ?? process.env
  const configPath = findForgeConfigFile(options?.searchFrom, options?.explicitPath, env)

  let parsedConfig: ForgeConfig = {}

  if (configPath !== null) {
    try {
      const rawContent = readFileSync(configPath, 'utf8')
      const cleaned = stripJsonComments(rawContent)
      if (cleaned.length > 0) {
        const json: unknown = JSON.parse(cleaned)
        parsedConfig = forgeConfigSchema.parse(json)
      }
    } catch (error) {
      throw new Error(
        `Failed to parse Forge config at "${configPath}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      )
    }
  }

  // Apply profile overrides if specified or active
  const profileName = options?.profile ?? env.FORGE_PROFILE ?? parsedConfig.activeProfile
  const activeProfileData = profileName ? parsedConfig.profiles?.[profileName] : undefined
  if (activeProfileData) {
    parsedConfig = applyProfileOverrides(parsedConfig, activeProfileData)
  }

  return applyEnvOverrides(parsedConfig, env)
}

/**
 * Merges environment variable overrides over parsed configuration.
 *
 * Precedence:
 * - `FORGE_DATA_DIR` overrides `dataDir`
 * - `FORGE_DEFAULT_RUNTIME` overrides `defaultRuntime`
 * - `FORGE_LOG_LEVEL` overrides `logLevel`
 * - `FORGE_TELEMETRY` overrides `telemetry`
 */
export function applyEnvOverrides(
  config: ForgeConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ForgeConfig {
  const result: ForgeConfig = { ...config }

  if (env.FORGE_DATA_DIR !== undefined && env.FORGE_DATA_DIR.trim() !== '') {
    result.dataDir = resolve(env.FORGE_DATA_DIR.trim())
  }

  if (env.FORGE_DEFAULT_RUNTIME !== undefined && env.FORGE_DEFAULT_RUNTIME.trim() !== '') {
    result.defaultRuntime = env.FORGE_DEFAULT_RUNTIME.trim()
  }

  if (env.FORGE_LOG_LEVEL !== undefined && env.FORGE_LOG_LEVEL.trim() !== '') {
    const level = env.FORGE_LOG_LEVEL.trim().toLowerCase()
    if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
      result.logLevel = level
    }
  }

  if (env.FORGE_TELEMETRY !== undefined) {
    const val = env.FORGE_TELEMETRY.trim().toLowerCase()
    if (val === '1' || val === 'true') {
      result.telemetry = true
    } else if (val === '0' || val === 'false') {
      result.telemetry = false
    }
  }

  return result
}

/**
 * Saves a Forge configuration to disk after validating against the schema.
 */
export function saveForgeConfig(configPath: string, config: ForgeConfig): void {
  const validated = forgeConfigSchema.parse(config)
  writeFileSync(configPath, `${JSON.stringify(validated, null, 2)}\n`, 'utf-8')
}

/**
 * Traverses a configuration object using dot-notation to read a property.
 */
export function getForgeConfigValue(keyPath: string, config: ForgeConfig): unknown {
  const parts = keyPath.split('.')
  let current: unknown = config
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * Updates a configuration key in .forgerc, validating the entire configuration before saving.
 */
export function setForgeConfigValue(
  keyPath: string,
  rawValue: unknown,
  configPath?: string,
): {
  readonly configPath: string
  readonly previousValue: unknown
  readonly newValue: unknown
  readonly updatedConfig: ForgeConfig
} {
  const targetPath = configPath ?? findForgeConfigFile() ?? join(process.cwd(), '.forgerc')

  let currentConfig: Record<string, unknown> = {}
  if (existsSync(targetPath)) {
    try {
      const content = readFileSync(targetPath, 'utf-8')
      currentConfig = JSON.parse(stripJsonComments(content)) as Record<string, unknown>
    } catch {
      currentConfig = {}
    }
  }

  const previousValue = getForgeConfigValue(keyPath, currentConfig)

  // Parse raw value if it is a string representation of boolean or integer
  let parsedValue = rawValue
  if (typeof rawValue === 'string') {
    if (rawValue.toLowerCase() === 'true') {
      parsedValue = true
    } else if (rawValue.toLowerCase() === 'false') {
      parsedValue = false
    } else if (/^-?\d+$/.test(rawValue)) {
      parsedValue = parseInt(rawValue, 10)
    }
  }

  // Clone and set nested key
  const updated = JSON.parse(JSON.stringify(currentConfig)) as Record<string, unknown>
  const parts = keyPath.split('.')
  let cursor = updated
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (part !== undefined) {
      if (typeof cursor[part] !== 'object' || cursor[part] === null) {
        cursor[part] = {}
      }
      cursor = cursor[part] as Record<string, unknown>
    }
  }
  const lastKey = parts[parts.length - 1]
  if (lastKey !== undefined) {
    cursor[lastKey] = parsedValue
  }

  // Validate whole config
  const validated = forgeConfigSchema.parse(updated)
  saveForgeConfig(targetPath, validated)

  return {
    configPath: targetPath,
    previousValue,
    newValue: parsedValue,
    updatedConfig: validated,
  }
}

/**
 * Lists available environment profiles and identifies the active one.
 */
export function listForgeProfiles(
  searchFrom?: string,
  explicitPath?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly activeProfile: string | null; readonly profiles: readonly string[] } {
  const configPath = findForgeConfigFile(searchFrom, explicitPath, env)
  if (configPath === null || !existsSync(configPath)) {
    return { activeProfile: null, profiles: [] }
  }

  try {
    const rawContent = readFileSync(configPath, 'utf8')
    const cleaned = stripJsonComments(rawContent)
    const json: unknown = JSON.parse(cleaned)
    const parsed = forgeConfigSchema.parse(json)
    const active = env.FORGE_PROFILE ?? parsed.activeProfile ?? null
    const profiles = parsed.profiles ? Object.keys(parsed.profiles).sort() : []
    return { activeProfile: active, profiles }
  } catch {
    return { activeProfile: null, profiles: [] }
  }
}

/**
 * Switches the active configuration profile in .forgerc.
 */
export function switchForgeProfile(
  profileName: string,
  configPath?: string,
): {
  readonly configPath: string
  readonly previousProfile: string | null
  readonly newProfile: string
} {
  const targetPath = configPath ?? findForgeConfigFile() ?? join(process.cwd(), '.forgerc')
  if (!existsSync(targetPath)) {
    throw new Error(`Configuration file not found at "${targetPath}"`)
  }

  const rawContent = readFileSync(targetPath, 'utf8')
  const cleaned = stripJsonComments(rawContent)
  const json: unknown = JSON.parse(cleaned)
  const parsed = forgeConfigSchema.parse(json)

  if (profileName !== 'default' && !parsed.profiles?.[profileName]) {
    const available = parsed.profiles ? Object.keys(parsed.profiles).join(', ') : 'none'
    throw new Error(
      `Profile "${profileName}" not found in .forgerc. Available profiles: ${available}`,
    )
  }

  const previous = parsed.activeProfile ?? null
  const updated: ForgeConfig = {
    ...parsed,
    activeProfile: profileName,
  }

  saveForgeConfig(targetPath, updated)

  return {
    configPath: targetPath,
    previousProfile: previous,
    newProfile: profileName,
  }
}
