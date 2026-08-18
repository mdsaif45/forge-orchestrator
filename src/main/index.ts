import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { ipcHandlers } from './ipc/handlers'
import { registerIpcHandlers } from './ipc/register'
import {
  applyContentSecurityPolicy,
  claimSingleInstance,
  denyAllPermissionRequests,
  lockWindowNavigation,
} from './security'

const devServerUrl = process.env.ELECTRON_RENDERER_URL

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
}
