import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { createForgeCore, type ForgeCore } from './core'
import { createIpcHandlers } from './ipc/handlers'
import { registerIpcHandlers } from './ipc/register'
import { GenericCliAgentRuntime } from './runtimes/genericCliRuntime'
import {
  applyContentSecurityPolicy,
  claimSingleInstance,
  denyAllPermissionRequests,
  lockWindowNavigation,
} from './security'

const devServerUrl = process.env.ELECTRON_RENDERER_URL

/**
 * Owns the headless Forge control plane core.
 *
 * Held at module scope so it outlives any single window and is accessible
 * during quit lifecycle hooks.
 */
let core: ForgeCore | null = null

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
    applyContentSecurityPolicy(devServerUrl)
    denyAllPermissionRequests()

    try {
      core = createForgeCore({
        dataDir: app.getPath('userData'),
        emitWorkflowEvent: (payload) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('workflow:event', payload)
            }
          }
        },
        emitWorkflowLog: (payload) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('workflow:log', payload)
            }
          }
        },
        emitTerminalData: (payload) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('terminal:data', payload)
            }
          }
        },
        emitTerminalExit: (payload) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('terminal:exit', payload)
            }
          }
        },
      })

      if (core.appliedMigrations > 0) {
        console.warn(`Applied ${String(core.appliedMigrations)} database migration(s)`)
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      dialog.showErrorBox('Forge cannot start', `The database could not be opened.\n\n${detail}`)
      app.exit(1)
      return
    }

    const activeCore = core
    registerIpcHandlers(
      createIpcHandlers({
        projects: activeCore.projects,
        workflows: activeCore.workflows,
        questions: activeCore.questions,
        decisions: activeCore.decisions,
        changeSets: activeCore.changeSets,
        accounts: activeCore.accounts,
        registry: activeCore.registry,
        bindings: activeCore.bindings,
        enrollment: activeCore.enrollment,
        terminal: activeCore.terminal,
        artifactService: activeCore.artifacts,
        // Broadcast provider chunks to all windows
        emitProviderChunk: (payload) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('provider:chunk', payload)
            }
          }
        },
        setActiveModel: (model) => {
          activeCore.activeModel.write(model)
        },
        registerCustomCli: (cli) => {
          if (!activeCore.registry.has(cli.id)) {
            activeCore.registry.register(
              new GenericCliAgentRuntime({
                id: cli.id,
                name: cli.name,
                executable: cli.executable,
                defaultArgs: cli.defaultArgs,
                processes: activeCore.processes,
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

  app.on('before-quit', () => {
    void core?.processes.killAll('Forge is shutting down')
  })

  app.on('will-quit', () => {
    void core?.close()
    core = null
  })
}
