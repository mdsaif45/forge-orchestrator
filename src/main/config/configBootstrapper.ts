import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cpus } from 'node:os'
import { forgeConfigSchema, type ForgeConfig } from './forgeConfig'

export interface BootstrapConfigOptions {
  readonly cwd: string
  readonly force?: boolean | undefined
  readonly model?: string | undefined
  readonly provider?: string | undefined
  readonly activeProfile?: string | undefined
}

export interface BootstrapConfigResult {
  readonly valid: boolean
  readonly created: boolean
  readonly configPath: string
  readonly config: ForgeConfig | null
  readonly formattedSummary: string
  readonly error?: string | undefined
}

/**
 * Probes environment and generates an initial .forgerc file for the workspace (Axioms A1, A6, A7).
 */
export async function bootstrapForgeConfig(
  options: BootstrapConfigOptions,
): Promise<BootstrapConfigResult> {
  await Promise.resolve()
  const targetPath = join(options.cwd, '.forgerc')

  if (existsSync(targetPath) && !options.force) {
    const msg = `Configuration file already exists at "${targetPath}". Pass --force to overwrite.`
    return {
      valid: false,
      created: false,
      configPath: targetPath,
      config: null,
      error: msg,
      formattedSummary: `✗ ${msg}`,
    }
  }

  // Detect project package.json
  const pkgPath = join(options.cwd, 'package.json')
  let detectedTestCommand: string | undefined
  let detectedBuildCommand: string | undefined
  if (existsSync(pkgPath)) {
    try {
      const raw = readFileSync(pkgPath, 'utf8')
      const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
      if (parsed.scripts?.test) detectedTestCommand = 'npm test'
      if (parsed.scripts?.build) detectedBuildCommand = 'npm run build'
    } catch {
      // Ignore package read failure
    }
  }

  // Determine provider and model
  const provider = options.provider ?? (process.env.OPENAI_API_KEY ? 'openai' : 'ollama')
  const model = options.model ?? (provider === 'openai' ? 'gpt-4o' : 'qwen2.5-coder:7b')

  const cpuCount = cpus().length

  const configToCreate: ForgeConfig = {
    logLevel: 'info',
    telemetry: false,
    activeProfile: options.activeProfile ?? 'local',
    security: {
      allowExecutionOutsideWorkspace: false,
      maxExecutionTimeMs: 300000,
    },
    providers: {
      [provider]: {
        model,
        endpoint: provider === 'ollama' ? 'http://127.0.0.1:11434' : undefined,
        apiKeyEnv: provider === 'openai' ? 'OPENAI_API_KEY' : undefined,
      },
    },
    profiles: {
      local: {
        logLevel: 'debug',
        security: {
          allowExecutionOutsideWorkspace: false,
          maxExecutionTimeMs: 600000,
        },
      },
      ci: {
        logLevel: 'info',
        security: {
          allowExecutionOutsideWorkspace: false,
          maxExecutionTimeMs: 180000,
        },
      },
    },
  }

  const validated = forgeConfigSchema.safeParse(configToCreate)
  if (!validated.success) {
    const msg = `Failed to validate generated configuration: ${validated.error.message}`
    return {
      valid: false,
      created: false,
      configPath: targetPath,
      config: null,
      error: msg,
      formattedSummary: `✗ ${msg}`,
    }
  }

  try {
    writeFileSync(targetPath, JSON.stringify(validated.data, null, 2), 'utf8')

    const lines: string[] = []
    lines.push('================================================================================')
    lines.push('FORGE WORKSPACE CONFIGURATION INITIALIZED')
    lines.push('================================================================================')
    lines.push(`  Path:           ${targetPath}`)
    lines.push(`  Provider:       ${provider}`)
    lines.push(`  Default Model:  ${model}`)
    lines.push(`  Active Profile: ${validated.data.activeProfile ?? 'none'}`)
    lines.push(`  System Cores:   ${String(cpuCount)}`)
    if (detectedTestCommand) {
      lines.push(`  Test Command:   ${detectedTestCommand}`)
    }
    if (detectedBuildCommand) {
      lines.push(`  Build Command:  ${detectedBuildCommand}`)
    }
    lines.push('================================================================================')
    lines.push(`✓ Successfully generated .forgerc conforming to forgeConfigSchema.`)

    return {
      valid: true,
      created: true,
      configPath: targetPath,
      config: validated.data,
      formattedSummary: lines.join('\n'),
    }
  } catch (err) {
    const msg = `Failed to write configuration file to "${targetPath}": ${err instanceof Error ? err.message : String(err)}`
    return {
      valid: false,
      created: false,
      configPath: targetPath,
      config: null,
      error: msg,
      formattedSummary: `✗ ${msg}`,
    }
  }
}
