/**
 * Verifies the design system as the browser actually resolves it.
 *
 * Inspecting the emitted CSS text is unreliable — Tailwind minifies and escapes
 * selectors, so a literal string search reports false negatives. Computed styles
 * are the ground truth: they prove a token reached a real element, and that a
 * theme switch changes it.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('node:path')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')

// A throwaway user-data directory per run. The theme is persisted to
// localStorage, so without this the previous run's toggle leaks in and the
// assertions below start from an unknown state.
app.setPath('userData', mkdtempSync(join(tmpdir(), 'forge-ui-check-')))

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
}

function evaluate(window, expression) {
  return window.webContents.executeJavaScript(expression)
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

  // The shell fetches app info on mount; without a handler it renders its error
  // branch, which is not the state under test here.
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
  // Let React mount before probing the DOM.
  await evaluate(window, `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`)

  // Tokens must resolve on the root element.
  const tokens = await evaluate(
    window,
    `(() => {
       const s = getComputedStyle(document.documentElement)
       return JSON.stringify({
         canvas: s.getPropertyValue('--color-canvas').trim(),
         accent: s.getPropertyValue('--color-accent').trim(),
         mono: s.getPropertyValue('--font-mono').trim().slice(0, 12),
         zToast: s.getPropertyValue('--z-toast').trim(),
       })
     })()`,
  )
  const t = JSON.parse(tokens)
  check(
    'design tokens resolve on the document root',
    t.canvas === '#0b0d10' && t.accent === '#4d8dff' && t.zToast === '60' && t.mono.length > 0,
    tokens,
  )

  // A token-based utility must actually paint. This is the check that a literal
  // CSS grep cannot make honestly.
  const painted = await evaluate(
    window,
    `(() => {
       const el = document.createElement('div')
       el.className = 'bg-(--color-accent) text-(length:--text-sm) rounded-(--radius-md)'
       document.body.append(el)
       const s = getComputedStyle(el)
       const out = { bg: s.backgroundColor, size: s.fontSize, radius: s.borderRadius }
       el.remove()
       return JSON.stringify(out)
     })()`,
  )
  const p = JSON.parse(painted)
  check(
    'token utilities generate real CSS (bg, font-size, radius)',
    p.bg === 'rgb(77, 141, 255)' && p.size === '13px' && p.radius === '6px',
    painted,
  )

  // The shell must be built from primitives, and they must render.
  const shell = await evaluate(
    window,
    `JSON.stringify({
       buttons: document.querySelectorAll('button').length,
       // StatusDot renders its label into an sr-only span.
       srLabels: document.querySelectorAll('.sr-only').length,
       // Code primitive, proving the runtime card resolved over IPC.
       codeCells: document.querySelectorAll('code').length,
     })`,
  )
  const s = JSON.parse(shell)
  check(
    'shell renders primitives (buttons, status labels, code cells)',
    s.buttons >= 2 && s.srLabels >= 2 && s.codeCells >= 5,
    shell,
  )

  // Switching the theme must repaint from tokens alone.
  // Setting the attribute directly is safe here because nothing re-renders in
  // between; `getBoundingClientRect` forces the pending style recalc to flush so
  // the read is not stale.
  const themed = await evaluate(
    window,
    `(() => {
       const read = () => {
         document.body.getBoundingClientRect()
         return getComputedStyle(document.body).backgroundColor
       }
       const before = read()
       document.documentElement.dataset.theme = 'light'
       const after = read()
       document.documentElement.dataset.theme = 'dark'
       return JSON.stringify({ before, after, restored: read() })
     })()`,
  )
  const th = JSON.parse(themed)
  check(
    'light theme repaints from tokens and dark restores',
    th.before === 'rgb(11, 13, 16)' &&
      th.after === 'rgb(255, 255, 255)' &&
      th.restored === 'rgb(11, 13, 16)',
    themed,
  )

  // The kitchen sink must render every primitive, in both themes — it is the
  // regression surface for the whole system.
  const sink = await evaluate(
    window,
    `(async () => {
       const open = [...document.querySelectorAll('button')]
         .find((b) => b.textContent.includes('Kitchen sink'))
       open.click()
       await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
       return JSON.stringify({
         tabs: document.querySelectorAll('[role="tab"]').length,
         tablist: document.querySelectorAll('[role="tablist"]').length,
         buttons: document.querySelectorAll('button').length,
         dialogs: document.querySelectorAll('dialog').length,
       })
     })()`,
  )
  const k = JSON.parse(sink)
  check(
    'kitchen sink renders tabs, controls and overlays',
    k.tabs === 4 && k.tablist === 1 && k.buttons > 15 && k.dialogs === 2,
    sink,
  )

  // Switch themes through the app's own control rather than by setting the
  // attribute directly: `useTheme` owns `data-theme`, so a manual write is
  // overwritten on the next render and would test nothing.
  const sinkLight = await evaluate(
    window,
    `(async () => {
       const toggle = [...document.querySelectorAll('button')]
         .find((b) => b.textContent.trim() === 'Light')
       if (toggle === undefined) return 'no-toggle'
       toggle.click()

       // React commits the theme in an effect, and the style recalc that follows
       // is not guaranteed to land on a frame boundary — polling on frames alone
       // is flaky. Wait until the computed value actually changes, with a bound
       // so a genuine regression still fails instead of hanging.
       const tab = document.querySelector('[role="tab"][aria-selected="true"]')
       const card = document.querySelector('[role="tablist"]')
       const target = 'rgb(20, 24, 29)'

       for (let i = 0; i < 60 && getComputedStyle(tab).color !== target; i += 1) {
         await new Promise((r) => requestAnimationFrame(r))
       }

       const out = {
         theme: document.documentElement.dataset.theme,
         tabColour: getComputedStyle(tab).color,
         borderColour: getComputedStyle(card).borderBottomColor,
       }

       const back = [...document.querySelectorAll('button')]
         .find((b) => b.textContent.trim() === 'Dark')
       back?.click()
       return JSON.stringify(out)
     })()`,
  )
  const sl = sinkLight === 'no-toggle' ? null : JSON.parse(sinkLight)
  check(
    'kitchen sink recolours through the theme control',
    sl !== null && sl.theme === 'light' && sl.tabColour === 'rgb(20, 24, 29)',
    sinkLight,
  )

  // Focus rings are an accessibility requirement, not a decoration.
  const focusRing = await evaluate(
    window,
    `(() => {
       const el = document.querySelector('button')
       el.focus()
       const s = getComputedStyle(el)
       return JSON.stringify({ focused: document.activeElement === el, outline: s.outlineStyle })
     })()`,
  )
  const f = JSON.parse(focusRing)
  check('buttons are focusable', f.focused === true, focusRing)

  for (const { name, pass, detail } of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `  (${detail})`}`)
  }

  const failed = checks.filter((c) => !c.pass).length
  console.log(`\n${checks.length - failed}/${checks.length} passed`)
  app.exit(failed === 0 ? 0 : 1)
})
