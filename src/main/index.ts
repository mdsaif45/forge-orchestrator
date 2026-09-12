import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { initialiseDatabase, type ForgeDatabase } from './db'
import { createIpcHandlers } from './ipc/handlers'
import { registerIpcHandlers } from './ipc/register'
import { OrphanTracker, ProcessManager } from './process'
import { AccountService } from './accounts/accountService'
import { AccountStore } from './db/accountStore'
import { EventStore } from './db/eventStore'
import { ChangeSetService } from './changesets/changeSetService'
import { DecisionService } from './decisions/decisionService'
import { ProjectService } from './projects/projectService'
import { QuestionService } from './questions/questionService'
import { WorkflowService } from './workflows/workflowService'
import { RuntimeRegistry, runtimeExecutable } from './runtimes/registry'
import { HostedClaudeRuntime } from './runtimes/hostedClaudeRuntime'
import { NativeAgentRuntime } from './runtimes/nativeAgentRuntime'
import {
  setCustomCliStorePath,
  setAgentDefaultsStorePath,
  loadCustomClis,
  STANDARD_AGENT_CATALOG,
} from './runtimes/cliDetector'
import { GenericCliAgentRuntime } from './runtimes/genericCliRuntime'
import { ActiveModelStore } from './providers/activeModel'
import { devModelTracker } from './providers/devModelTracker'
import { AgentSessionRegistry } from './terminal/sessionRegistry'
import { TerminalService } from './terminal/terminalService'
import { BindingService } from './bindings/bindingService'
import { AccountHomes } from './accounts/accountHomes'
import { EnrollmentService } from './accounts/enrollmentService'
import { BindingStore } from './db/bindingStore'
import {
  applyContentSecurityPolicy,
  claimSingleInstance,
  denyAllPermissionRequests,
  lockWindowNavigation,
} from './security'

const devServerUrl = process.env.ELECTRON_RENDERER_URL

/**
 * Owns every child process Forge starts.
 *
 * Module scope because it must outlive any one window and be reachable from the quit
 * handler: a per-window manager would leak processes when a window closed. Constructed
 * lazily during startup rather than here, because `app.getPath('userData')` is only
 * meaningful once Electron is ready.
 */
let processes: ProcessManager | null = null

/**
 * The open database handle.
 *
 * Held at module scope because it is opened once during startup and closed on
 * quit; a per-window handle would mean several connections writing one file.
 */
let database: { readonly db: ForgeDatabase; readonly close: () => void } | null = null

/**
 * Opens the database before any window exists.
 *
 * A failure here is fatal and reported directly: Forge owns the project truth, so
 * running without persistence would mean an app that appears to work while
 * silently keeping nothing.
 */
function startDatabase(): ForgeDatabase | null {
  const file = join(app.getPath('userData'), 'forge.db')

  try {
    const { db, close, applied } = initialiseDatabase(file)
    database = { db, close }

    if (applied > 0) {
      console.warn(`Applied ${String(applied)} database migration(s)`)
    }

    return db
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('Forge cannot start', `The database could not be opened.\n\n${detail}`)
    app.exit(1)
    return null
  }
}

function createWindow(): BrowserWindow {
  const options: Electron.BrowserWindowConstructorOptions = {
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#131315',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      // The renderer is untrusted: no Node, no shared context, sandboxed.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Deny the renderer the ability to spawn its own privileged surfaces.
      webviewTag: false,
      nodeIntegrationInSubFrames: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  }

  if (process.platform === 'win32') {
    options.titleBarOverlay = {
      color: '#00000000',
      symbolColor: '#8b929c',
      height: 38,
    }
  } else if (process.platform === 'darwin') {
    options.trafficLightPosition = { x: 14, y: 12 }
  }

  const window = new BrowserWindow(options)

  window.on('ready-to-show', () => {
    window.show()
  })

  // Pipe all renderer errors and console messages to terminal so issues are visible
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levels = ['LOG', 'INFO', 'WARN', 'ERROR']
    const label = levels[level] ?? 'LOG'
    console.warn(`[Renderer ${label}] ${message} (${sourceId}:${String(line)})`)
  })

  lockWindowNavigation(window, devServerUrl)

  if (devServerUrl !== undefined) {
    window.webContents.openDevTools({ mode: 'detach' })
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return window
}

// One orchestrator per user data directory: two instances would contend over the
// same database and the same working trees.
if (!claimSingleInstance()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing === undefined) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  void app.whenReady().then(() => {
    const db = startDatabase()
    applyContentSecurityPolicy(devServerUrl)
    denyAllPermissionRequests()

    // `app.exit` inside startDatabase does not unwind this callback, so a null
    // handle means the process is already going down and no handler should bind.
    if (db === null) return

    // Reaped *before* the manager starts anything, so a crashed run's agents are gone
    // before a resumed workflow diffs the tree they were editing.
    const orphans = new OrphanTracker(join(app.getPath('userData'), 'processes.json'))

    void orphans.reap().then((report) => {
      if (report.killed.length > 0) {
        console.warn(
          `Killed ${String(report.killed.length)} orphaned process(es) from a previous run`,
        )
      }
      if (report.foreign.length > 0) {
        console.warn('Another Forge instance owns the recorded processes; left them alone')
      }
    })

    processes = new ProcessManager({
      logDirectory: join(app.getPath('userData'), 'logs'),
      orphans,
    })

    const accountHomes = new AccountHomes(join(app.getPath('userData'), 'accounts'))

    // Where the renderer publishes which model the native agent should use, so
    // a workflow running entirely in main can read it (see activeModel.ts).
    const activeModel = new ActiveModelStore(join(app.getPath('userData'), 'active-model.json'))

    const registry = new RuntimeRegistry()
    const agentSessions = new AgentSessionRegistry()

    /*
     * Only runtimes that do real work against a real repository are registered.
     *
     * Three were removed rather than left selectable, because each was a
     * substitute for the thing it claimed to be:
     *
     *   mock:default     scripted output. Useful for tests, which construct it
     *                    directly; registered in the app it was a runtime a
     *                    role could be bound to that would report success
     *                    without doing anything (A3). `MockAgentRuntime` still
     *                    exists and every test still uses it.
     *   claude-cli       `claude -p --output-format stream-json --safe-mode`,
     *                    with its stdout hand-parsed. `--safe-mode` strips the
     *                    CLI's own hooks and configuration, so this was not the
     *                    Claude Code CLI a user runs — it was a reimplementation
     *                    of one, against an undocumented wire format.
     *                    ADR-003 supersedes it; `claude-cli-hosted` runs the
     *                    real thing.
     *   antigravity-cli  the same shape for `agy` (`-p`,
     *                    `--output-format=stream-json`). `agy --help` confirms
     *                    `-i/--prompt-interactive` exists, so a hosted
     *                    equivalent is possible and is what #168 should build.
     *
     * The adapters are still in the tree with their measured CLI facts intact
     * (#172 gates deleting them). What changed is that nothing binds a role to
     * a parsed-stdout substitute any more.
     */

    // Forge's own agent: the model plus Forge's tool loop, no CLI in between.
    // The one runtime that works with any model from any provider — Ollama and
    // LM Studio locally, or any OpenAI-compatible endpoint with a key.
    registry.register(
      new NativeAgentRuntime({
        // Read at send time, not at construction: the user can change provider
        // or model between turns, and a captured value would go stale.
        resolveModel: () => activeModel.read(),
      }),
    )

    // The original Claude Code CLI, hosted as a live interactive session. No
    // `-p`, no `--output-format`, no `--safe-mode`: the CLI a user runs, with
    // its own hooks intact, and turn completion reported by those hooks rather
    // than inferred from the screen (ADR-003).
    registry.register(
      new HostedClaudeRuntime({
        processes,
        hookReceiverDir: join(app.getPath('userData'), 'hooks'),
      }),
    )

    setCustomCliStorePath(join(app.getPath('userData'), 'custom-clis.json'))
    setAgentDefaultsStorePath(join(app.getPath('userData'), 'agent-defaults.json'))

    // Register all standard CLI agents from the catalog (Agy, OpenCode, Codex, Aider, Cline, etc.)
    for (const agent of STANDARD_AGENT_CATALOG) {
      if (!registry.has(agent.id)) {
        registry.register(
          new GenericCliAgentRuntime({
            id: agent.id,
            name: agent.name,
            executable: agent.executable,
            processes,
          }),
        )
      }
    }

    // Register user-configured custom CLIs
    for (const customCli of loadCustomClis()) {
      if (!registry.has(customCli.id)) {
        registry.register(
          new GenericCliAgentRuntime({
            id: customCli.id,
            name: customCli.name,
            executable: customCli.executable,
            defaultArgs: customCli.defaultArgs,
            processes,
          }),
        )
      }
    }

    // Late-bound on purpose: WorkflowService depends on ProjectService, so reading it
    // through a closure is what keeps the construction order one-way while still
    // letting a project edit be refused during a run (#112).
    let workflows: WorkflowService | null = null

    const projectService = new ProjectService(
      db,
      (projectId) => workflows !== null && workflows.getActive(projectId) !== null,
    )
    const workflowService = new WorkflowService({
      db,
      projects: projectService,
      packetDir: join(app.getPath('userData'), 'packets'),
      // Where a running step's process is published, so the workflow pane can
      // attach to the real run rather than spawning a second session (#170).
      sessions: agentSessions,
      // Under userData rather than beside the repository, so Forge never creates
      // directories inside a project the user did not ask it to write to.
      worktreeRoot: join(app.getPath('userData'), 'worktrees'),
      registry,
      emitEvent: (payload) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('workflow:event', payload)
          }
        }
      },
      emitLog: (payload) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('workflow:log', payload)
          }
        }
      },
    })

    // Completes the late binding above. Until this runs the predicate answers false,
    // which is correct: no workflow can be running before the service that runs them
    // exists.
    workflows = workflowService

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
      emitData: (payload) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('terminal:data', payload)
          }
        }
      },
      emitExit: (payload) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('terminal:exit', payload)
          }
        }
      },
    })

    devModelTracker.subscribe((record) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('dev:modelCall', record)
        }
      }
    })

    registerIpcHandlers(
      createIpcHandlers({
        projects: projectService,
        workflows: workflowService,
        questions: questionService,
        decisions: decisionService,
        changeSets: changeSetService,
        accounts: accountService,
        registry,
        bindings: new BindingService(new BindingStore(db, eventStore), registry),
        enrollment: new EnrollmentService(accountHomes, registry, runtimeExecutable),
        terminal: terminalService,
        // Broadcast, like the terminal and workflow channels above: a chunk goes
        // to every live window, and the renderer filters on its own streamId.
        emitProviderChunk: (payload) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('provider:chunk', payload)
            }
          }
        },
        // Persisted so a workflow, which runs entirely in main, can reach the
        // model the user picked in the renderer (see activeModel.ts).
        setActiveModel: (model) => {
          activeModel.write(model)
        },
        registerCustomCli: (cli) => {
          if (!registry.has(cli.id)) {
            registry.register(
              new GenericCliAgentRuntime({
                id: cli.id,
                name: cli.name,
                executable: cli.executable,
                defaultArgs: cli.defaultArgs,
                processes,
              }),
            )
          }
        },
      }),
    )

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // A killed Electron process that leaves agent CLIs running against the user's
  // repository is worse than a crash: the work keeps happening with nothing supervising
  // it, and the next start would diff against a tree something else is still editing.
  //
  // Kills are started here, on `before-quit`, which fires before windows close and so
  // gives the signals a head start on the rest of shutdown.
  //
  // Deliberately *not* `event.preventDefault()` with a re-issued `app.quit()`: that
  // cancels the whole quit sequence, and the re-issued quit then races a shutdown
  // Electron has already abandoned. Measured — it hung `app.close()` indefinitely and
  // took the e2e suite from 4s to a 30s teardown timeout. The pty kill is a signal, not a
  // wait, so blocking quit on it buys nothing.
  app.on('before-quit', () => {
    void processes?.killAll('Forge is shutting down')
  })

  // Closing the handle flushes the WAL, so the next start does not have to recover.
  app.on('will-quit', () => {
    database?.close()
    database = null
  })
}
