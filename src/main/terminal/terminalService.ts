import type { ProcessHandle, ProcessManager } from '../process/processManager'
import type { ProjectService } from '../projects/projectService'

export interface TerminalEventDataPayload {
  readonly terminalId: string
  readonly chunk: string
}

export interface TerminalEventExitPayload {
  readonly terminalId: string
  readonly exitCode: number | null
}

export interface TerminalServiceOptions {
  readonly processes: ProcessManager
  readonly projects: ProjectService
  readonly emitData: (payload: TerminalEventDataPayload) => void
  readonly emitExit: (payload: TerminalEventExitPayload) => void
}

export class TerminalService {
  private readonly sessions = new Map<string, ProcessHandle>()

  constructor(private readonly options: TerminalServiceOptions) {}

  async spawn(req: {
    readonly projectId: string
    readonly command?: string | undefined
    readonly args?: readonly string[] | undefined
    readonly cwd?: string | undefined
    readonly env?: Readonly<Record<string, string>> | undefined
    readonly cols?: number | undefined
    readonly rows?: number | undefined
  }): Promise<{ readonly terminalId: string; readonly pid?: number | undefined }> {
    const detail = await this.options.projects.get(req.projectId)
    if (detail === null) {
      throw new Error(`Project ${req.projectId} not found`)
    }

    const terminalId = `term-${Date.now().toString()}-${Math.random().toString(36).slice(2, 7)}`
    const targetCwd = req.cwd ?? detail.project.repository.absolutePath

    // Default command: if not specified, default to powershell on win32 or sh on posix
    const defaultShell = process.platform === 'win32' ? 'powershell.exe' : 'bash'
    const command = req.command ?? defaultShell
    const args = req.args ?? []

    const handle = await this.options.processes.spawn({
      command,
      args,
      cwd: targetCwd,
      ...(req.env !== undefined ? { env: req.env } : {}),
      cols: req.cols ?? 100,
      rows: req.rows ?? 30,
    })

    this.sessions.set(terminalId, handle)

    handle.onData((chunk) => {
      this.options.emitData({ terminalId, chunk })
    })

    void handle.completed.then((outcome) => {
      this.sessions.delete(terminalId)
      this.options.emitExit({ terminalId, exitCode: outcome.exitCode })
    })

    return { terminalId }
  }

  write(terminalId: string, data: string): void {
    const handle = this.sessions.get(terminalId)
    if (handle !== undefined) {
      handle.write(data)
    }
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const handle = this.sessions.get(terminalId)
    if (handle?.resize !== undefined) {
      handle.resize(cols, rows)
    }
  }

  async kill(terminalId: string): Promise<void> {
    const handle = this.sessions.get(terminalId)
    if (handle !== undefined) {
      await handle.cancel('Terminal closed by user')
      this.sessions.delete(terminalId)
    }
  }
}
