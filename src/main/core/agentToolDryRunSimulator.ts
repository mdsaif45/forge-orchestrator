import { normalize } from 'node:path'

export type ToolMutationSeverity =
  'READ_ONLY' | 'WORKSPACE_MUTATION' | 'SYSTEM_COMMAND' | 'DESTRUCTIVE'

export interface PlannedToolInvocation {
  toolName: string
  parameters?: Record<string, unknown> | undefined
  args?: Record<string, unknown> | undefined
  targetPaths?: string[] | undefined
  isDangerous?: boolean | undefined
}

export interface ToolDryRunConfig {
  workspaceRoot?: string | undefined
  forbiddenPaths?: string[] | undefined
  maxAllowedBlastRadius?: number | undefined
}

export interface ToolDryRunReport {
  toolName: string
  isAllowed: boolean
  severity: ToolMutationSeverity
  predictedChanges: string[]
  blastRadiusScore: number
  diagnostics: string[]
  remediationHints: string[]
}

const READ_ONLY_TOOLS = new Set([
  'file_read',
  'read_file',
  'directory_list',
  'list_directory',
  'search_code',
  'git_status',
  'grep',
  'glob',
  'cat',
  'inspect',
])

const SYSTEM_COMMAND_TOOLS = new Set([
  'run_command',
  'execute_command',
  'exec',
  'bash',
  'powershell',
  'sh',
  'shell',
])

const DESTRUCTIVE_TOOLS = new Set([
  'file_delete',
  'delete_file',
  'remove_file',
  'rm',
  'rimraf',
  'git_reset',
  'drop_table',
  'purge',
])

const DEFAULT_FORBIDDEN_PREFIXES = ['.git', '.kilo', '.vscode', 'node_modules']

export class AgentToolDryRunSimulator {
  private readonly defaultForbidden: string[]
  private readonly defaultMaxBlastRadius: number

  constructor(config?: ToolDryRunConfig) {
    this.defaultForbidden = config?.forbiddenPaths ?? DEFAULT_FORBIDDEN_PREFIXES
    this.defaultMaxBlastRadius = config?.maxAllowedBlastRadius ?? 20
  }

  public simulate(
    invocation: PlannedToolInvocation,
    overrideConfig?: ToolDryRunConfig,
  ): ToolDryRunReport {
    const forbidden = overrideConfig?.forbiddenPaths ?? this.defaultForbidden
    const maxBlastRadius = overrideConfig?.maxAllowedBlastRadius ?? this.defaultMaxBlastRadius

    const diagnostics: string[] = []
    const remediationHints: string[] = []

    // 1. Determine tool severity
    const lowerName = invocation.toolName.toLowerCase()
    let severity: ToolMutationSeverity = 'WORKSPACE_MUTATION'

    if (READ_ONLY_TOOLS.has(lowerName)) {
      severity = 'READ_ONLY'
    } else if (DESTRUCTIVE_TOOLS.has(lowerName) || invocation.isDangerous === true) {
      severity = 'DESTRUCTIVE'
    } else if (SYSTEM_COMMAND_TOOLS.has(lowerName)) {
      severity = 'SYSTEM_COMMAND'
    }

    // 2. Collect target paths
    const targetPaths: string[] = []
    const params = invocation.parameters ?? invocation.args ?? {}
    if (invocation.targetPaths && invocation.targetPaths.length > 0) {
      targetPaths.push(...invocation.targetPaths)
    } else if (typeof params.path === 'string') {
      targetPaths.push(params.path)
    } else if (typeof params.filePath === 'string') {
      targetPaths.push(params.filePath)
    } else if (Array.isArray(params.paths)) {
      for (const p of params.paths) {
        if (typeof p === 'string') {
          targetPaths.push(p)
        }
      }
    }

    // 3. Inspect path safety & boundary containment
    let boundaryViolated = false
    const normalizedTargets: string[] = []

    for (const target of targetPaths) {
      const norm = normalize(target).replace(/^[\\/]+/, '')
      normalizedTargets.push(norm)

      // Path traversal check
      if (target.includes('..') || norm.startsWith('..')) {
        boundaryViolated = true
        diagnostics.push(`Target path "${target}" traverses outside workspace boundary.`)
        remediationHints.push('Confine tool operations strictly within the workspace root.')
      }

      // Forbidden path check
      for (const forbiddenPrefix of forbidden) {
        if (
          norm === forbiddenPrefix ||
          norm.startsWith(`${forbiddenPrefix}/`) ||
          norm.startsWith(`${forbiddenPrefix}\\`)
        ) {
          boundaryViolated = true
          diagnostics.push(
            `Target path "${target}" touches protected directory "${forbiddenPrefix}".`,
          )
          remediationHints.push(`Do not modify protected directories (${forbidden.join(', ')}).`)
        }
      }
    }

    // 4. Compute blast radius score
    let blastRadiusScore: number
    if (severity === 'READ_ONLY') {
      blastRadiusScore = 0
    } else if (severity === 'WORKSPACE_MUTATION') {
      blastRadiusScore = Math.max(1, normalizedTargets.length)
    } else if (severity === 'SYSTEM_COMMAND') {
      blastRadiusScore = 5
    } else {
      blastRadiusScore = Math.max(5, normalizedTargets.length * 3)
    }

    if (blastRadiusScore > maxBlastRadius) {
      diagnostics.push(
        `Estimated blast radius score (${String(blastRadiusScore)}) exceeds allowed ceiling (${String(maxBlastRadius)}).`,
      )
      remediationHints.push('Decompose operation into smaller, targeted sub-actions.')
    }

    const isAllowed = !boundaryViolated && blastRadiusScore <= maxBlastRadius

    return {
      toolName: invocation.toolName,
      isAllowed,
      severity,
      predictedChanges: severity === 'READ_ONLY' ? [] : normalizedTargets,
      blastRadiusScore,
      diagnostics,
      remediationHints,
    }
  }
}
