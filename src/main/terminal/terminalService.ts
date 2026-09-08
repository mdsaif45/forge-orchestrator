import type { ProcessHandle, ProcessManager } from '../process/processManager'
import type { ProjectService } from '../projects/projectService'
import type { AgentSessionRegistry, AttachableProcess } from './sessionRegistry'

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
  readonly runtimeExecutable?: ((runtimeId: string) => string) | undefined
  readonly sessions?: AgentSessionRegistry | undefined
  readonly emitData: (payload: TerminalEventDataPayload) => void
  readonly emitExit: (payload: TerminalEventExitPayload) => void
}

const MAX_BUFFER_LENGTH = 256 * 1024 // 256 KB rolling window

export class TerminalService {
  private readonly sessions = new Map<string, ProcessHandle>()
  private readonly buffers = new Map<string, string>()
  private readonly agentSubscriptions = new Map<
    string,
    { handle: AttachableProcess; unsubscribe: () => void }
  >()

  constructor(private readonly options: TerminalServiceOptions) {
    if (options.sessions !== undefined) {
      options.sessions.onPublished((key) => {
        this.attachAgentSession(key)
      })
    }
  }

  private attachAgentSession(key: string): void {
    const registry = this.options.sessions
    if (registry === undefined) return

    const handle = registry.lookup(key)
    if (handle === null) return

    // Clean up previous subscription for this key if re-running
    const previous = this.agentSubscriptions.get(key)
    if (previous !== undefined) {
      previous.unsubscribe()
      this.agentSubscriptions.delete(key)
    }

    if (handle.onData !== undefined) {
      const unsub = handle.onData((chunk) => {
        this.recordChunk(key, chunk)
        this.options.emitData({ terminalId: key, chunk })
      })

      this.agentSubscriptions.set(key, { handle, unsubscribe: unsub })
    }
  }

  private recordChunk(terminalId: string, chunk: string): void {
    const existing = this.buffers.get(terminalId) ?? ''
    const combined = existing + chunk
    if (combined.length > MAX_BUFFER_LENGTH) {
      this.buffers.set(terminalId, combined.slice(combined.length - MAX_BUFFER_LENGTH))
    } else {
      this.buffers.set(terminalId, combined)
    }
  }

  getBuffer(terminalId: string): string {
    return this.buffers.get(terminalId) ?? ''
  }

  async spawn(req: {
    readonly projectId: string
    readonly runtimeId?: string | null | undefined
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

    const resolvedCli =
      req.runtimeId !== null &&
      req.runtimeId !== undefined &&
      this.options.runtimeExecutable !== undefined
        ? this.options.runtimeExecutable(req.runtimeId)
        : undefined

    const defaultShell = process.platform === 'win32' ? 'powershell.exe' : 'bash'
    const command = req.command ?? resolvedCli ?? defaultShell
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
      this.recordChunk(terminalId, chunk)
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
      return
    }

    const agentProcess = this.options.sessions?.lookup(terminalId)
    if (agentProcess?.write !== undefined) {
      agentProcess.write(data)
    }
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const handle = this.sessions.get(terminalId)
    if (handle?.resize !== undefined) {
      handle.resize(cols, rows)
      return
    }

    const agentProcess = this.options.sessions?.lookup(terminalId)
    if (agentProcess?.resize !== undefined) {
      agentProcess.resize(cols, rows)
    }
  }

  async kill(terminalId: string): Promise<void> {
    const handle = this.sessions.get(terminalId)
    if (handle !== undefined) {
      await handle.cancel('Terminal closed by user')
      this.sessions.delete(terminalId)
      this.buffers.delete(terminalId)
    }
  }
}
