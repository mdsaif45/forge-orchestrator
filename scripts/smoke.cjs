/**
 * Headless smoke check for the built app.
 *
 * Verifies three things the build alone cannot prove:
 *   1. the main process creates a window and the renderer loads
 *   2. the preload bridge reaches the renderer (`window.forge` exists)
 *   3. the renderer has no Node access (axiom A7 at the process boundary)
 *
 * Replaced by the Playwright suite in #12; kept small and dependency-free so
 * `npm run build` can be sanity-checked from day one.
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(__dirname, '../out/preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  await window.loadFile(join(__dirname, '../out/renderer/index.html'))

  const heading = await window.webContents.executeJavaScript(
    `document.querySelector('h1')?.textContent ?? null`,
  )
  check('renderer mounts React and renders the shell', heading === 'Forge', `h1 = ${heading}`)

  const bridge = await window.webContents.executeJavaScript(
    `typeof window.forge?.versions?.electron`,
  )
  check('preload bridge is exposed', bridge === 'string', `typeof = ${bridge}`)

  const leaked = await window.webContents.executeJavaScript(
    `[typeof window.require, typeof window.process, typeof window.module].join(',')`,
  )
  check('renderer has no Node access', leaked === 'undefined,undefined,undefined', leaked)

  for (const { name, pass, detail } of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `  (${detail})`}`)
  }

  const failed = checks.filter((c) => !c.pass).length
  console.log(`\n${checks.length - failed}/${checks.length} passed`)
  app.exit(failed === 0 ? 0 : 1)
})
