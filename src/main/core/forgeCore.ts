import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ProviderChunkPayload, WorkflowEventPayload, WorkflowLogPayload } from '@shared/ipc'
import { initialiseDatabase } from '../db'
import type { ForgeDatabase, OpenDatabaseResult } from '../db'
import type { ChangeSetStore } from '../db/changeSetStore'
import { OrphanTracker, ProcessManager } from '../process'
import { AccountService } from '../accounts/accountService'
import { AccountStore } from '../db/accountStore'
import { EventStore } from '../db/eventStore'
import { ChangeSetService } from '../changesets/changeSetService'
import { DecisionService } from '../decisions/decisionService'
import { ProjectService } from '../projects/projectService'
import { QuestionService } from '../questions/questionService'
import { WorkflowService } from '../workflows/workflowService'
import { RuntimeRegistry, runtimeExecutable } from '../runtimes/registry'
import { registerDefaultRuntimes } from '../runtimes/defaultRuntimes'
import { ActiveModelStore, type ActiveModel } from '../providers/activeModel'
import { AgentSessionRegistry } from '../terminal/sessionRegistry'
import {
  TerminalService,
  type TerminalEventDataPayload,
  type TerminalEventExitPayload,
} from '../terminal/terminalService'
import { BindingService } from '../bindings/bindingService'
import { AccountHomes } from '../accounts/accountHomes'
import { EnrollmentService } from '../accounts/enrollmentService'
import { BindingStore } from '../db/bindingStore'

/**
 * Resolves the configuration and storage directory for Forge.
 *
 * Precedence:
 * 1. Explicit directory argument passed to Forge
 * 2. `FORGE_DATA_DIR` environment variable
 * 3. System-standard application directory (%APPDATA%\forge on Windows, ~/.forge on POSIX)
 */
export function resolveDataDir(explicit?: string): string {
  if (explicit !== undefined && explicit.trim() !== '') {
    return resolve(explicit)
  }

  const envDir = process.env.FORGE_DATA_DIR
  if (envDir !== undefined && envDir.trim() !== '') {
    return resolve(envDir)
  }

  if (process.platform === 'win32' && process.env.APPDATA !== undefined) {
    return join(process.env.APPDATA, 'forge')
  }

  return join(homedir(), '.forge')
}

export interface ForgeCoreOptions {
  /** Root directory for databases, logs, worktrees, packets, and account storage. */
  readonly dataDir?: string | undefined

  /** Optional callback when workflow lifecycle events are emitted. */
  readonly emitWorkflowEvent?: ((payload: WorkflowEventPayload) => void) | undefined

  /** Optional callback when workflow step logs are emitted. */
  readonly emitWorkflowLog?: ((payload: WorkflowLogPayload) => void) | undefined

  /** Optional callback for terminal output streaming. */
  readonly emitTerminalData?: ((payload: TerminalEventDataPayload) => void) | undefined

  /** Optional callback when terminal processes exit. */
  readonly emitTerminalExit?: ((payload: TerminalEventExitPayload) => void) | undefined

  /** Optional callback for streaming model provider chunks. */
  readonly emitProviderChunk?: ((payload: ProviderChunkPayload) => void) | undefined

  /** Optional active model override for headless runs. */
  readonly resolveActiveModel?: (() => ActiveModel | null) | undefined
}

export interface ForgeCore {
  readonly dataDir: string
  readonly db: ForgeDatabase
  readonly sqlite: OpenDatabaseResult['sqlite']
  readonly processes: ProcessManager
  readonly orphans: OrphanTracker
  readonly accountHomes: AccountHomes
  readonly activeModel: ActiveModelStore
  readonly registry: RuntimeRegistry
  readonly runtimes: RuntimeRegistry
  readonly agentSessions: AgentSessionRegistry
  readonly projects: ProjectService
  readonly workflows: WorkflowService
  readonly questions: QuestionService
  readonly decisions: DecisionService
  readonly changeSets: ChangeSetService
  readonly changeSetStore: ChangeSetStore
  readonly accounts: AccountService
  readonly terminal: TerminalService
  readonly bindings: BindingService
  readonly enrollment: EnrollmentService
  readonly appliedMigrations: number

  /** Closes database connection, terminates child processes, and flushes storage. */
  readonly close: () => Promise<void>
}

/**
 * Initializes the headless Forge control plane core.
 *
 * This function decouples all database initialization, process management,
 * runtime registries, and domain services from Electron's process lifecycle,
 * allowing Forge to run identically in desktop and standalone CLI/headless modes.
 */
const NOOP = (): void => {
  // Deliberate no-op default for terminal output when headless
}

export function createForgeCore(options: ForgeCoreOptions = {}): ForgeCore {
  const dataDir = resolveDataDir(options.dataDir)

  // Ensure standard directory tree exists
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(dataDir, 'logs'), { recursive: true })
  mkdirSync(join(dataDir, 'packets'), { recursive: true })
  mkdirSync(join(dataDir, 'worktrees'), { recursive: true })
  mkdirSync(join(dataDir, 'accounts'), { recursive: true })
  mkdirSync(join(dataDir, 'hooks'), { recursive: true })

  const dbFile = join(dataDir, 'forge.db')
  const {
    db,
    sqlite,
    close: closeDatabase,
    applied: appliedMigrations,
  } = initialiseDatabase(dbFile)

  const orphans = new OrphanTracker(join(dataDir, 'processes.json'))
  void orphans.reap().catch(() => {
    // Non-fatal reap failure on start
  })

  const processes = new ProcessManager({
    logDirectory: join(dataDir, 'logs'),
    orphans,
  })

  const accountHomes = new AccountHomes(join(dataDir, 'accounts'))
  const activeModel = new ActiveModelStore(join(dataDir, 'active-model.json'))

  const registry = new RuntimeRegistry()
  const agentSessions = new AgentSessionRegistry()

  registerDefaultRuntimes(registry, {
    processes,
    dataDir,
    activeModel,
    ...(options.resolveActiveModel ? { resolveActiveModel: options.resolveActiveModel } : {}),
  })

  // Late-bound circular dependency between workflows and projects
  let workflowsRef: WorkflowService | null = null

  const projectService = new ProjectService(
    db,
    (projectId) => workflowsRef !== null && workflowsRef.getActive(projectId) !== null,
  )

  const workflowService = new WorkflowService({
    db,
    projects: projectService,
    packetDir: join(dataDir, 'packets'),
    sessions: agentSessions,
    worktreeRoot: join(dataDir, 'worktrees'),
    registry,
    ...(options.emitWorkflowEvent ? { emitEvent: options.emitWorkflowEvent } : {}),
    ...(options.emitWorkflowLog ? { emitLog: options.emitWorkflowLog } : {}),
  })

  workflowsRef = workflowService

  const questionService = new QuestionService({
    questions: workflowService.getQuestionStore(),
  })

  const decisionService = new DecisionService({
    decisions: workflowService.getDecisionStore(),
  })

  const changeSetService = new ChangeSetService({
    changeSets: workflowService.getChangeSetStore(),
    projects: projectService,
  })

  const eventStore = new EventStore(db)
  const accountStore = new AccountStore(db, eventStore)
  const accountService = new AccountService(accountStore)

  const terminalService = new TerminalService({
    processes,
    projects: projectService,
    runtimeExecutable,
    sessions: agentSessions,
    emitData: options.emitTerminalData ?? NOOP,
    emitExit: options.emitTerminalExit ?? NOOP,
  })

  const bindingStore = new BindingStore(db, eventStore)
  const bindingService = new BindingService(bindingStore, registry)
  const enrollmentService = new EnrollmentService(accountHomes, registry, runtimeExecutable)

  const close = async (): Promise<void> => {
    try {
      await processes.killAll('Forge core is shutting down')
    } catch {
      // Ignore kill failures during shutdown
    }
    closeDatabase()
  }

  return {
    dataDir,
    db,
    sqlite,
    processes,
    orphans,
    accountHomes,
    activeModel,
    registry,
    runtimes: registry,
    agentSessions,
    projects: projectService,
    workflows: workflowService,
    questions: questionService,
    decisions: decisionService,
    changeSets: changeSetService,
    changeSetStore: workflowService.getChangeSetStore(),
    accounts: accountService,
    terminal: terminalService,
    bindings: bindingService,
    enrollment: enrollmentService,
    appliedMigrations,
    close,
  }
}
