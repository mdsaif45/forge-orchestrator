import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface InstalledCliInfo {
  readonly id: string
  readonly name: string
  readonly executable: string
  readonly available: boolean
  readonly resolvedPath?: string | undefined
}

const KNOWN_CLI_AGENTS = [
  { id: 'claude', name: 'Claude Code CLI', executable: 'claude' },
  { id: 'opencode', name: 'OpenCode CLI', executable: 'opencode' },
  { id: 'codex', name: 'Codex CLI', executable: 'codex' },
  { id: 'agy', name: 'Antigravity CLI (agy)', executable: 'agy' },
  { id: 'aider', name: 'Aider AI Pair Programmer', executable: 'aider' },
] as const

/**
 * Probes the operating system PATH to detect installed AI coding CLIs.
 */
export async function detectInstalledClis(): Promise<readonly InstalledCliInfo[]> {
  const isWin = process.platform === 'win32'
  const lookupCmd = isWin ? 'where.exe' : 'which'

  const results: InstalledCliInfo[] = []

  for (const cli of KNOWN_CLI_AGENTS) {
    try {
      const { stdout } = await execFileAsync(lookupCmd, [cli.executable], {
        timeout: 2000,
        windowsHide: true,
      })
      const firstLine = stdout.trim().split(/\r?\n/)[0] ?? ''
      results.push({
        id: cli.id,
        name: cli.name,
        executable: cli.executable,
        available: firstLine.length > 0,
        resolvedPath: firstLine.length > 0 ? firstLine : undefined,
      })
    } catch {
      results.push({
        id: cli.id,
        name: cli.name,
        executable: cli.executable,
        available: false,
      })
    }
  }

  return results
}
