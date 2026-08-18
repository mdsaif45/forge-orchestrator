/**
 * Headless smoke check for the built app.
 *
 * Verifies what a green build cannot: that the process boundary actually holds
 * at runtime. Replaced by the Playwright + vitest suites in #12; kept small and
 * dependency-free so the boundary is checkable from day one.
 *
 * Channel-level behaviour (unknown channels, payload validation) is covered by
 * `scripts/router-check.mjs`, which tests the router directly.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('node:path')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')

// A throwaway user-data directory, so persisted renderer state from a previous
// run cannot influence these assertions.
app.setPath('userData', mkdtempSync(join(tmpdir(), 'forge-smoke-')))

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
}

function evaluate(window, expression) {
  return window.webContents.executeJavaScript(expression)
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  // The app's own policy, imported rather than reimplemented, so this asserts
  // the shipped CSP and not a copy of it.
  const { applyContentSecurityPolicy, contentSecurityPolicy } =
    await import('../out/main/security.js')
  applyContentSecurityPolicy(undefined)

  const policy = contentSecurityPolicy(undefined)
  check(
    'production CSP has no unsafe-inline and no remote origins',
    !policy.includes('unsafe-inline') && !policy.includes('http'),
    policy,
  )

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(__dirname, '../out/preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Stands in for the app's own handler, so this check routes through the real
  // preload bridge without depending on main's startup sequence. The envelope
  // shape matches what the router returns.
  ipcMain.handle('app:getInfo', () => ({
    ok: true,
    value: {
      name: 'Forge',
      version: '0.0.1',
      platform: process.platform,
      versions: { electron: 'x', chrome: 'y', node: 'z' },
    },
  }))

  await window.loadFile(join(__dirname, '../out/renderer/index.html'))

  // Asserts React mounted and produced real DOM. Deliberately structural rather
  // than tied to specific copy or tag names, so shell redesigns do not break it
  // — `check:ui` is where the design system itself is asserted.
  const mounted = await evaluate(
    window,
    `JSON.stringify({
       children: document.getElementById('root')?.children.length ?? 0,
       buttons: document.querySelectorAll('button').length,
     })`,
  )
  const m = JSON.parse(mounted)
  check('renderer mounts React and renders the shell', m.children > 0 && m.buttons > 0, mounted)

  const name = await evaluate(
    window,
    `window.forge.app.getInfo().then((r) => r.ok ? r.value.name : 'failed:' + r.code)`,
  )
  check('preload bridge reaches main and returns typed data', name === 'Forge', `name = ${name}`)

  // Axiom A7 at the process boundary.
  const leaked = await evaluate(
    window,
    `[typeof window.require, typeof window.process, typeof window.module, typeof window.Buffer].join(',')`,
  )
  check('renderer has no Node access', leaked === 'undefined,undefined,undefined,undefined', leaked)

  // The renderer must not be able to name a channel at all.
  const surface = await evaluate(
    window,
    `JSON.stringify({
       keys: Object.keys(window.forge),
       app: Object.keys(window.forge.app),
       invoke: typeof window.forge.invoke,
       send: typeof window.forge.send,
       ipc: typeof window.forge.ipcRenderer,
     })`,
  )
  const s = JSON.parse(surface)
  check(
    'no generic invoke/send passthrough is exposed',
    s.invoke === 'undefined' &&
      s.send === 'undefined' &&
      s.ipc === 'undefined' &&
      s.keys.join(',') === 'app' &&
      s.app.join(',') === 'getInfo',
    surface,
  )

  // A failure must cross the bridge with its code intact. The context bridge
  // strips error prototypes and own properties, so the envelope is what carries
  // the code; `@renderer/ipc` turns it back into a real error on that side.
  ipcMain.removeHandler('app:getInfo')
  ipcMain.handle('app:getInfo', () => ({
    ok: false,
    code: 'HANDLER_FAILED',
    message: 'deliberate failure',
  }))
  const failureOutcome = await evaluate(
    window,
    `window.forge.app
       .getInfo()
       .then((r) => r.ok ? 'unexpected-ok' : r.code + '|' + r.message)`,
  )
  check(
    'failure envelope crosses the bridge with its code intact',
    failureOutcome === 'HANDLER_FAILED|deliberate failure',
    failureOutcome,
  )

  // The CSP must actually reach the renderer, not merely be configured.
  const externalFetch = await evaluate(
    window,
    `fetch('https://example.com/probe').then(() => 'ALLOWED').catch(() => 'BLOCKED')`,
  )
  check(
    'CSP blocks external network access from the renderer',
    externalFetch === 'BLOCKED',
    externalFetch,
  )

  for (const { name: label, pass, detail } of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  (${detail})`}`)
  }

  const failed = checks.filter((c) => !c.pass).length
  console.log(`\n${checks.length - failed}/${checks.length} passed`)
  app.exit(failed === 0 ? 0 : 1)
})
