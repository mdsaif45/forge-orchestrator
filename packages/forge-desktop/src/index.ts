/**
 * @forge/desktop — Electron application lifecycle, contextBridge preload bridge,
 * and React 19 workstation UI configuration for Forge.
 */

export interface DesktopWindowOptions {
  readonly width: number
  readonly height: number
  readonly minWidth: number
  readonly minHeight: number
  readonly show: boolean
  readonly autoHideMenuBar: boolean
  readonly backgroundColor: string
  readonly titleBarStyle: 'hidden' | 'default' | 'hiddenInset'
  readonly webPreferences: {
    readonly preload?: string | undefined
    readonly contextIsolation: boolean
    readonly nodeIntegration: boolean
    readonly sandbox: boolean
  }
}

export const DEFAULT_DESKTOP_WINDOW_OPTIONS: DesktopWindowOptions = {
  width: 1440,
  height: 900,
  minWidth: 1024,
  minHeight: 680,
  show: false,
  autoHideMenuBar: true,
  backgroundColor: '#131315',
  titleBarStyle: 'hidden',
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
}

export function createDesktopWindowOptions(
  overrides: Partial<DesktopWindowOptions> = {},
): DesktopWindowOptions {
  return {
    ...DEFAULT_DESKTOP_WINDOW_OPTIONS,
    ...overrides,
    webPreferences: {
      ...DEFAULT_DESKTOP_WINDOW_OPTIONS.webPreferences,
      ...(overrides.webPreferences ?? {}),
    },
  }
}

export type { IpcDependencies } from './main/ipc/handlers'
export type { IpcHandlerMap } from './main/ipc/router'
