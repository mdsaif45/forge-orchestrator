import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface InstalledCliInfo {
  readonly id: string
  readonly name: string
  readonly executable: string
  readonly available: boolean
  readonly installation: 'installed' | 'not_installed'
  readonly authentication: 'authorized' | 'unauthorized' | 'unknown' | 'not_applicable'
  readonly resolvedPath?: string | undefined
  readonly isCustom?: boolean | undefined
  readonly defaultModel?: string | undefined
  readonly models?:
    | readonly { readonly id: string; readonly label: string; readonly category?: string | undefined }[]
    | undefined
}

export interface CustomCliConfig {
  readonly id: string
  readonly name: string
  readonly executable: string
  readonly description?: string | undefined
  readonly defaultArgs?: readonly string[] | undefined
  readonly argsTemplate?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly capabilities?: readonly string[] | undefined
  readonly permissionMode?: 'developer' | 'ask' | 'headless' | undefined
}

export interface AgentDefaultsConfig {
  readonly defaultWorker?: string | undefined
  readonly workerModel?: string | undefined
  readonly defaultOrchestrator?: string | undefined
  readonly orchestratorModel?: string | undefined
  readonly defaultReviewer?: string | undefined
  readonly permissionMode?: string | undefined
  readonly autoReviewPrs?: boolean | undefined
}

export interface StandardAgentInfo {
  readonly id: string
  readonly name: string
  readonly executable: string
  readonly defaultModel?: string | undefined
  readonly models?:
    | readonly {
        readonly id: string
        readonly label: string
        readonly category?: string | undefined
      }[]
    | undefined
}

/**
 * The standard catalog of 27 coding CLI agent providers.
 * Conforms to Forge Axiom A6 (confined to src/main/runtimes/*).
 */
export const STANDARD_AGENT_CATALOG: readonly StandardAgentInfo[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    executable: 'claude',
    defaultModel: 'sonnet',
    models: [
      { id: 'sonnet', label: 'Claude 3.7 Sonnet', category: 'Claude Models' },
      { id: 'haiku', label: 'Claude 3.5 Haiku', category: 'Claude Models' },
      { id: 'opus', label: 'Claude 3 Opus', category: 'Claude Models' },
    ],
  },
  {
    id: 'agy',
    name: 'Agy',
    executable: 'agy',
    defaultModel: 'gemini-3.1-pro',
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', category: 'Gemini Models' },
      { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', category: 'Gemini Models' },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', category: 'Gemini Models' },
      { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', category: 'Gemini Models' },
      { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)', category: 'Gemini Models' },
      { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)', category: 'Gemini Models' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', category: 'Claude & Open Models' },
      { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)', category: 'Claude & Open Models' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', category: 'Claude & Open Models' },
    ],
  },
  { id: 'cline', name: 'Cline', executable: 'cline' },
  {
    id: 'opencode',
    name: 'OpenCode',
    executable: 'opencode',
    defaultModel: 'deepseek-r1',
    models: [
      { id: 'deepseek-r1', label: 'DeepSeek R1', category: 'Open Models' },
      { id: 'deepseek-v3', label: 'DeepSeek V3', category: 'Open Models' },
      { id: 'qwen-2.5-coder', label: 'Qwen 2.5 Coder', category: 'Open Models' },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    executable: 'codex',
    defaultModel: 'o3-mini',
    models: [
      { id: 'o3-mini', label: 'OpenAI o3-mini', category: 'OpenAI Models' },
      { id: 'gpt-4o', label: 'GPT-4o', category: 'OpenAI Models' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', category: 'OpenAI Models' },
    ],
  },
  { id: 'aider', name: 'Aider', executable: 'aider' },
  { id: 'continue', name: 'Continue', executable: 'continue' },
  { id: 'kilocode', name: 'Kilo Code', executable: 'kilocode' },
  { id: 'auggie', name: 'Auggie', executable: 'auggie' },
  { id: 'copilot', name: 'GitHub Copilot', executable: 'copilot' },
  { id: 'pi', name: 'Pi', executable: 'pi' },
  { id: 'qwen', name: 'Qwen Code', executable: 'qwen' },
  { id: 'cursor', name: 'Cursor', executable: 'cursor' },
  { id: 'amp', name: 'Amp', executable: 'amp' },
  { id: 'autohand', name: 'Autohand', executable: 'autohand' },
  { id: 'crush', name: 'Crush', executable: 'crush' },
  { id: 'devin', name: 'Devin', executable: 'devin' },
  { id: 'droid', name: 'Droid', executable: 'droid' },
  { id: 'goose', name: 'Goose', executable: 'goose' },
  { id: 'grok', name: 'Grok Build', executable: 'grok' },
  { id: 'kimchi', name: 'Kimchi', executable: 'kimchi' },
  { id: 'kimi', name: 'Kimi', executable: 'kimi' },
  { id: 'kiro', name: 'Kiro', executable: 'kiro' },
  { id: 'vibe', name: 'Mistral Vibe', executable: 'vibe' },
  { id: 'muse', name: 'Muse Code', executable: 'muse' },
  { id: 'omp', name: 'OMP', executable: 'omp' },
  { id: 'prime-agent', name: 'Prime Agent', executable: 'prime-agent' },
]

let customClisFilePath: string | null = null
let agentDefaultsFilePath: string | null = null

export function setCustomCliStorePath(filePath: string): void {
  customClisFilePath = filePath
}

export function setAgentDefaultsStorePath(filePath: string): void {
  agentDefaultsFilePath = filePath
}

export function loadCustomClis(): readonly CustomCliConfig[] {
  if (customClisFilePath === null) return []
  try {
    const content = readFileSync(customClisFilePath, 'utf8')
    return JSON.parse(content) as CustomCliConfig[]
  } catch {
    return []
  }
}

export function saveCustomCli(cli: CustomCliConfig): readonly CustomCliConfig[] {
  const current = loadCustomClis().filter((c) => c.id !== cli.id)
  const updated = [...current, cli]
  if (customClisFilePath !== null) {
    mkdirSync(dirname(customClisFilePath), { recursive: true })
    writeFileSync(customClisFilePath, JSON.stringify(updated, null, 2), 'utf8')
  }
  cachedClis = getCatalogClis()
  return updated
}

export function removeCustomCli(id: string): readonly CustomCliConfig[] {
  const current = loadCustomClis().filter((c) => c.id !== id)
  if (customClisFilePath !== null) {
    mkdirSync(dirname(customClisFilePath), { recursive: true })
    writeFileSync(customClisFilePath, JSON.stringify(current, null, 2), 'utf8')
  }
  cachedClis = getCatalogClis()
  return current
}

export function loadAgentDefaults(): AgentDefaultsConfig {
  if (agentDefaultsFilePath === null) {
    return {
      defaultWorker: 'agy',
      workerModel: '(agent default)',
      defaultOrchestrator: 'claude',
      orchestratorModel: 'Agent default',
      defaultReviewer: 'Project default',
      permissionMode: 'Project default',
      autoReviewPrs: false,
    }
  }
  try {
    const content = readFileSync(agentDefaultsFilePath, 'utf8')
    return JSON.parse(content) as AgentDefaultsConfig
  } catch {
    return {
      defaultWorker: 'agy',
      workerModel: '(agent default)',
      defaultOrchestrator: 'claude',
      orchestratorModel: 'Agent default',
      defaultReviewer: 'Project default',
      permissionMode: 'Project default',
      autoReviewPrs: false,
    }
  }
}

export function saveAgentDefaults(defaults: AgentDefaultsConfig): AgentDefaultsConfig {
  if (agentDefaultsFilePath !== null) {
    mkdirSync(dirname(agentDefaultsFilePath), { recursive: true })
    writeFileSync(agentDefaultsFilePath, JSON.stringify(defaults, null, 2), 'utf8')
  }
  return defaults
}

/**
 * Tests known credential and auth indicators for CLI agents.
 */
function probeAuthStatus(
  id: string,
  available: boolean,
): 'authorized' | 'unauthorized' | 'unknown' | 'not_applicable' {
  if (!available) return 'not_applicable'

  const home = homedir()

  if (id === 'claude') {
    const credPath = join(home, '.claude', '.credentials.json')
    if (
      existsSync(credPath) ||
      Boolean(process.env.ANTHROPIC_API_KEY) ||
      Boolean(process.env.CLAUDE_API_KEY)
    ) {
      return 'authorized'
    }
    return 'unknown'
  }

  if (id === 'agy') {
    const agyAuthDir = join(home, '.gemini')
    const agyConfig = join(home, '.antigravity')
    if (existsSync(agyAuthDir) || existsSync(agyConfig) || Boolean(process.env.GEMINI_API_KEY)) {
      return 'authorized'
    }
    return 'unknown'
  }

  if (id === 'copilot') {
    const ghConfig = join(home, '.config', 'gh', 'hosts.yml')
    if (existsSync(ghConfig) || Boolean(process.env.GITHUB_TOKEN)) {
      return 'authorized'
    }
    return 'unknown'
  }

  return 'unknown'
}

/**
 * Checks common candidate installation paths on disk.
 */
function checkCandidatePaths(executable: string): string | undefined {
  const isWin = process.platform === 'win32'
  const home = homedir()

  if (isWin) {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')

    const candidates = [
      join(appData, 'npm', `${executable}.cmd`),
      join(appData, 'npm', executable),
      join(localAppData, 'Programs', executable, `${executable}.exe`),
      join(localAppData, 'Programs', 'Antigravity', 'bin', `${executable}.cmd`),
      join(home, '.cargo', 'bin', `${executable}.exe`),
      join(localAppData, 'Microsoft', 'WinGet', 'Links', `${executable}.exe`),
    ]

    for (const p of candidates) {
      if (existsSync(p)) return p
    }
  } else {
    const candidates = [
      join('/usr/local/bin', executable),
      join('/opt/homebrew/bin', executable),
      join(home, '.cargo', 'bin', executable),
      join(home, '.local', 'bin', executable),
    ]

    for (const p of candidates) {
      if (existsSync(p)) return p
    }
  }

  return undefined
}

export function getCatalogClis(): readonly InstalledCliInfo[] {
  const customClis = loadCustomClis()
  const standard: InstalledCliInfo[] = STANDARD_AGENT_CATALOG.map((c) => ({
    id: c.id,
    name: c.name,
    executable: c.executable,
    available: true,
    installation: 'installed',
    authentication: 'unknown',
    isCustom: false,
    defaultModel: c.defaultModel,
    models: c.models,
  }))
  const custom: InstalledCliInfo[] = customClis.map((c) => ({
    id: c.id,
    name: c.name,
    executable: c.executable,
    available: true,
    installation: 'installed',
    authentication: 'unknown',
    isCustom: true,
    defaultModel: undefined,
    models: undefined,
  }))
  return [...standard, ...custom]
}

let cachedClis: readonly InstalledCliInfo[] = getCatalogClis()

async function probeAllClis(): Promise<readonly InstalledCliInfo[]> {
  const isWin = process.platform === 'win32'
  const lookupCmd = isWin ? 'where.exe' : 'which'

  const customClis = loadCustomClis()

  const allToProbe = [
    ...STANDARD_AGENT_CATALOG.map((c) => ({
      id: c.id,
      name: c.name,
      executable: c.executable,
      defaultModel: c.defaultModel,
      models: c.models,
      isCustom: false,
    })),
    ...customClis.map((c) => ({
      id: c.id,
      name: c.name,
      executable: c.executable,
      defaultModel: undefined,
      models: undefined,
      isCustom: true,
    })),
  ]

  const results: InstalledCliInfo[] = []

  await Promise.all(
    allToProbe.map(async (cli) => {
      let resolvedPath: string | undefined

      // 1. PATH lookup
      try {
        const { stdout } = await execFileAsync(lookupCmd, [cli.executable], {
          timeout: 2500,
          windowsHide: true,
        })
        const firstLine = stdout.trim().split(/\r?\n/)[0]?.trim()
        if (firstLine && firstLine.length > 0) {
          resolvedPath = firstLine
        }
      } catch {
        // Fall through to candidate paths
      }

      // 2. Candidate paths lookup if PATH lookup did not hit
      resolvedPath ??= checkCandidatePaths(cli.executable)

      const available = resolvedPath !== undefined
      const auth = probeAuthStatus(cli.id, available)

      results.push({
        id: cli.id,
        name: cli.name,
        executable: cli.executable,
        available,
        installation: available ? 'installed' : 'not_installed',
        authentication: auth,
        resolvedPath,
        isCustom: cli.isCustom,
        defaultModel: cli.defaultModel,
        models: cli.models,
      })
    }),
  )

  // Maintain catalog order: standard catalog entries first, then custom CLIs
  const orderMap = new Map<string, number>()
  STANDARD_AGENT_CATALOG.forEach((item, index) => {
    orderMap.set(item.id, index)
  })

  cachedClis = results.sort((a, b) => {
    const idxA = orderMap.get(a.id) ?? 999
    const idxB = orderMap.get(b.id) ?? 999
    if (idxA !== idxB) return idxA - idxB
    return a.name.localeCompare(b.name)
  })

  return cachedClis
}

/**
 * Probes the operating system PATH and candidate paths to detect installed AI coding CLIs.
 * Returns the cached catalog immediately, then updates candidate paths in the background.
 */
export async function detectInstalledClis(forceRefresh = false): Promise<readonly InstalledCliInfo[]> {
  if (!forceRefresh && cachedClis.length > 0) {
    void probeAllClis().catch(() => undefined)
    return cachedClis
  }
  return probeAllClis()
}

// Warm up CLI detection asynchronously on module load
void detectInstalledClis().catch(() => undefined)
