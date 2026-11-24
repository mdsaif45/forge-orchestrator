import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DESKTOP_WINDOW_OPTIONS,
  createDesktopWindowOptions,
  createIpcHandlers,
  registerIpcHandlers,
} from './index'

describe('@forge/desktop package window and ipc contracts', () => {
  it('verifies default window options adhere to desktop security standards', () => {
    expect(DEFAULT_DESKTOP_WINDOW_OPTIONS.width).toBe(1440)
    expect(DEFAULT_DESKTOP_WINDOW_OPTIONS.height).toBe(900)
    expect(DEFAULT_DESKTOP_WINDOW_OPTIONS.minWidth).toBe(1024)
    expect(DEFAULT_DESKTOP_WINDOW_OPTIONS.minHeight).toBe(680)

    // Strict security boundaries: contextIsolation enabled, nodeIntegration disabled, sandboxed
    expect(DEFAULT_DESKTOP_WINDOW_OPTIONS.webPreferences.contextIsolation).toBe(true)
    expect(DEFAULT_DESKTOP_WINDOW_OPTIONS.webPreferences.nodeIntegration).toBe(false)
    expect(DEFAULT_DESKTOP_WINDOW_OPTIONS.webPreferences.sandbox).toBe(true)
  })

  it('allows safe window option overrides while preserving security defaults', () => {
    const custom = createDesktopWindowOptions({
      width: 1920,
      height: 1080,
    })

    expect(custom.width).toBe(1920)
    expect(custom.height).toBe(1080)
    expect(custom.webPreferences.contextIsolation).toBe(true)
    expect(custom.webPreferences.sandbox).toBe(true)
  })

  it('exports IPC handler factory and registration functions', () => {
    expect(typeof createIpcHandlers).toBe('function')
    expect(typeof registerIpcHandlers).toBe('function')
  })
})
