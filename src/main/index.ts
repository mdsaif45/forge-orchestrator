import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { initialiseDatabase, type ForgeDatabase } from './db'
import { ipcHandlers } from './ipc/handlers'
import { registerIpcHandlers } from './ipc/register'
import {
  applyContentSecurityPolicy,
  claimSingleInstance,
  denyAllPermissionRequests,
  lockWindowNavigation,
} from './security'

const devServerUrl = process.env.ELECTRON_RENDERER_URL

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
function startDatabase(): void {
  const file = join(app.getPath('userData'), 'forge.db')

  try {
    const { db, close, applied } = initialiseDatabase(file)
    database = { db, close }

    if (applied > 0) {
      console.warn(`Applied ${String(applied)} database migration(s)`)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('Forge cannot start', `The database could not be opened.\n\n${detail}`)
    app.exit(1)
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d10',
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
  })

  window.on('ready-to-show', () => {
    window.show()
  })
  lockWindowNavigation(window, devServerUrl)

  if (devServerUrl !== undefined) {
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
    startDatabase()
    applyContentSecurityPolicy(devServerUrl)
    denyAllPermissionRequests()
    registerIpcHandlers(ipcHandlers)

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Closing the handle flushes the WAL, so the next start does not have to recover.
  app.on('will-quit', () => {
    database?.close()
    database = null
  })
}
