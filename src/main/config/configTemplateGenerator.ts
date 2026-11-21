import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { forgeConfigSchema, type ForgeConfig } from './forgeConfig'

export type ConfigPresetName = 'node-ts' | 'python' | 'rust' | 'go' | 'minimal'

export interface ConfigPresetInfo {
  readonly id: ConfigPresetName
  readonly name: string
  readonly description: string
  readonly language: string
  readonly defaultRuntime: string
}

export interface WriteConfigTemplateOptions {
  readonly preset: ConfigPresetName
  readonly targetDir?: string | undefined
  readonly filename?: string | undefined
  readonly force?: boolean | undefined
  readonly overrides?: Partial<ForgeConfig> | undefined
}

export interface ConfigTemplateWriteResult {
  readonly valid: boolean
  readonly created: boolean
  readonly preset: ConfigPresetName
  readonly path: string
  readonly config: ForgeConfig
  readonly formattedSummary: string
  readonly error?: string | undefined
}

const PRESET_DEFINITIONS: Record<ConfigPresetName, ConfigPresetInfo> = {
  'node-ts': {
    id: 'node-ts',
    name: 'Node.js / TypeScript',
    description: 'Configuration preset tailored for Node.js and TypeScript ecosystems.',
    language: 'typescript',
    defaultRuntime: 'agent:orchestrator',
  },
  python: {
    id: 'python',
    name: 'Python',
    description: 'Configuration preset tailored for Python, pytest, and venv environments.',
    language: 'python',
    defaultRuntime: 'agent:orchestrator',
  },
  rust: {
    id: 'rust',
    name: 'Rust / Cargo',
    description: 'Configuration preset tailored for Rust and Cargo toolchains.',
    language: 'rust',
    defaultRuntime: 'agent:orchestrator',
  },
  go: {
    id: 'go',
    name: 'Go Toolchain',
    description: 'Configuration preset tailored for Go modules and test pipelines.',
    language: 'go',
    defaultRuntime: 'agent:orchestrator',
  },
  minimal: {
    id: 'minimal',
    name: 'Minimal Configuration',
    description: 'Lean baseline configuration with strict sandboxing and bounded timeouts.',
    language: 'generic',
    defaultRuntime: 'agent:orchestrator',
  },
}

/**
 * Returns a list of all available configuration presets.
 */
export function listConfigPresets(): readonly ConfigPresetInfo[] {
  return Object.values(PRESET_DEFINITIONS)
}

/**
 * Generates a pre-validated ForgeConfig object for the given preset with optional overrides.
 */
export function generateConfigTemplate(
  preset: ConfigPresetName,
  overrides?: Partial<ForgeConfig>,
): ForgeConfig {
  if (!(preset in PRESET_DEFINITIONS)) {
    throw new Error(
      `Unknown configuration preset "${preset}". Available presets: ${Object.keys(PRESET_DEFINITIONS).join(', ')}`,
    )
  }

  let rawConfig: ForgeConfig

  switch (preset) {
    case 'node-ts':
      rawConfig = {
        dataDir: '.forge',
        defaultRuntime: 'agent:orchestrator',
        logLevel: 'info',
        telemetry: false,
        activeProfile: 'dev',
        security: {
          allowExecutionOutsideWorkspace: false,
          maxExecutionTimeMs: 300_000,
        },
        customRuntimes: [
          {
            id: 'custom:node-worker',
            name: 'Node TypeScript Worker',
            command: 'npx',
            argsTemplate: ['ts-node', '{{prompt}}'],
            capabilities: ['terminal', 'file-write', 'repo-read', 'test'],
          },
        ],
        profiles: {
          dev: {
            logLevel: 'debug',
            security: {
              allowExecutionOutsideWorkspace: false,
              maxExecutionTimeMs: 120_000,
            },
          },
          ci: {
            logLevel: 'warn',
            security: {
              allowExecutionOutsideWorkspace: false,
              maxExecutionTimeMs: 600_000,
            },
          },
        },
      }
      break

    case 'python':
      rawConfig = {
        dataDir: '.forge',
        defaultRuntime: 'agent:orchestrator',
        logLevel: 'info',
        telemetry: false,
        security: {
          allowExecutionOutsideWorkspace: false,
          maxExecutionTimeMs: 300_000,
        },
        customRuntimes: [
          {
            id: 'custom:python-worker',
            name: 'Python Environment Worker',
            command: 'python',
            argsTemplate: ['-m', 'pytest', '{{prompt}}'],
            capabilities: ['terminal', 'repo-read', 'test'],
          },
        ],
        profiles: {
          dev: {
            logLevel: 'debug',
          },
          ci: {
            logLevel: 'warn',
          },
        },
      }
      break

    case 'rust':
      rawConfig = {
        dataDir: '.forge',
        defaultRuntime: 'agent:orchestrator',
        logLevel: 'info',
        telemetry: false,
        security: {
          allowExecutionOutsideWorkspace: false,
          maxExecutionTimeMs: 600_000,
        },
        customRuntimes: [
          {
            id: 'custom:cargo-runner',
            name: 'Cargo Rust Runner',
            command: 'cargo',
            argsTemplate: ['test', '{{prompt}}'],
            capabilities: ['terminal', 'repo-read', 'test'],
          },
        ],
      }
      break

    case 'go':
      rawConfig = {
        dataDir: '.forge',
        defaultRuntime: 'agent:orchestrator',
        logLevel: 'info',
        telemetry: false,
        security: {
          allowExecutionOutsideWorkspace: false,
          maxExecutionTimeMs: 300_000,
        },
        customRuntimes: [
          {
            id: 'custom:go-runner',
            name: 'Go Toolchain Runner',
            command: 'go',
            argsTemplate: ['test', './...'],
            capabilities: ['terminal', 'repo-read', 'test'],
          },
        ],
      }
      break

    case 'minimal':
    default:
      rawConfig = {
        dataDir: '.forge',
        defaultRuntime: 'agent:orchestrator',
        logLevel: 'info',
        telemetry: false,
        security: {
          allowExecutionOutsideWorkspace: false,
          maxExecutionTimeMs: 180_000,
        },
      }
      break
  }

  const merged = overrides ? { ...rawConfig, ...overrides } : rawConfig
  const validated = forgeConfigSchema.parse(merged)
  return validated
}

/**
 * Writes a configuration template file to disk (Axioms A1, A2, A7).
 */
export function writeConfigTemplate(
  options: WriteConfigTemplateOptions,
): ConfigTemplateWriteResult {
  const targetDir = options.targetDir ? resolve(options.targetDir) : process.cwd()
  const filename = options.filename ?? '.forgerc'
  const filePath = join(targetDir, filename)

  const config = generateConfigTemplate(options.preset, options.overrides)

  if (existsSync(filePath) && !options.force) {
    const errorMsg = `Configuration file already exists at "${filePath}". Pass --force to overwrite.`
    return {
      valid: false,
      created: false,
      preset: options.preset,
      path: filePath,
      config,
      error: errorMsg,
      formattedSummary: `✗ [CONFIG-TEMPLATE] ${errorMsg}`,
    }
  }

  try {
    const serialized = JSON.stringify(config, null, 2) + '\n'
    writeFileSync(filePath, serialized, 'utf8')

    return {
      valid: true,
      created: true,
      preset: options.preset,
      path: filePath,
      config,
      formattedSummary: `✓ [CONFIG-TEMPLATE] Created "${filename}" using "${options.preset}" preset at ${filePath}`,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return {
      valid: false,
      created: false,
      preset: options.preset,
      path: filePath,
      config,
      error: errorMsg,
      formattedSummary: `✗ [CONFIG-TEMPLATE] Failed to write template: ${errorMsg}`,
    }
  }
}
