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

  // The shell loads projects on mount. These checks cover the design system, not
  // persistence, so the project channels are stubbed empty. Leaving them
  // unhandled would surface as a renderer-side error that replaces the very page
  // being asserted on.
  ipcMain.handle('project:list', () => ({ ok: true, value: { projects: [] } }))
  ipcMain.handle('project:get', () => ({ ok: true, value: null }))

  await window.loadFile(join(__dirname, '../out/renderer/index.html'))
  // Let React mount before probing the DOM.
  await evaluate(
    window,
    `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`,
  )

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
  //
  // The recalc that follows a `data-theme` change is asynchronous, and
  // `getBoundingClientRect` does not force it — that flushes layout, not the
  // style invalidation from an attribute change. So each read polls until the
  // value settles, bounded so a real regression fails rather than hanging. An
  // earlier version read immediately and passed locally while failing on the
  // slower Windows runner.
  const themed = await evaluate(
    window,
    `(async () => {
       const read = () => getComputedStyle(document.body).backgroundColor

       const readUntil = async (expected) => {
         for (let i = 0; i < 120 && read() !== expected; i += 1) {
           await new Promise((r) => requestAnimationFrame(r))
         }
         return read()
       }

       const dark = 'rgb(11, 13, 16)'
       const light = 'rgb(255, 255, 255)'

       const before = await readUntil(dark)
       document.documentElement.dataset.theme = 'light'
       const after = await readUntil(light)
       document.documentElement.dataset.theme = 'dark'
       const restored = await readUntil(dark)

       return JSON.stringify({ before, after, restored })
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
    // Four dialogs: the sink's own host, the Dialog and Drawer it demos, and the
    // shell's create-project dialog. `Dialog` renders its <dialog> element even
    // while closed, which is what lets the native top layer manage it.
    k.tabs === 4 && k.tablist === 1 && k.buttons > 15 && k.dialogs === 4,
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

  // Close the sink before exercising navigation: it is rendered in a modal, which
  // holds focus and would intercept the clicks below.
  const closed = await evaluate(
    window,
    `(async () => {
       // Scoped to the dialog that is actually open. Several closed <dialog>
       // elements are in the DOM — Dialog renders its element regardless of open
       // state — and each has its own close button, so an unscoped selector can
       // click an inert one and leave the modal holding focus.
       const button = document.querySelector('dialog[open] button[aria-label="Close dialog"]')
       button?.click()
       await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
       return JSON.stringify({ clicked: button !== null, stillOpen: document.querySelectorAll('dialog[open]').length })
     })()`,
  )
  // Asserted rather than assumed: a silent no-op here previously left the modal
  // open, and the only symptom was an unrelated focus check failing much later.
  const cl = JSON.parse(closed)
  check(
    'the modal closes through its own control',
    cl.clicked === true && cl.stillOpen === 0,
    closed,
  )

  // Every nav item must resolve to a real route. This is the check that catches a
  // dead link, which is the failure mode a hand-maintained nav list invites.
  const navigation = await evaluate(
    window,
    `(async () => {
       const settle = () =>
         new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

       const links = [...document.querySelectorAll('nav[aria-label="Main"] a')]
       const visited = []

       for (const link of links) {
         link.click()
         await settle()
         visited.push({
           label: link.textContent.trim(),
           hash: window.location.hash,
           // The catch-all route renders this copy; reaching it means the link
           // pointed at a path the router does not know.
           notFound: document.body.textContent.includes('Route not found'),
           heading: document.querySelector('main h1')?.textContent?.trim() ?? null,
           current: link.getAttribute('aria-current'),
         })
       }

       return JSON.stringify({ count: links.length, visited })
     })()`,
  )
  const nav = JSON.parse(navigation)
  const deadLinks = nav.visited.filter((v) => v.notFound)
  const unheaded = nav.visited.filter((v) => v.heading === null)
  const mislabelled = nav.visited.filter((v) => v.heading !== v.label)

  check(
    'every nav item routes to a live page (no dead links)',
    nav.count === 8 && deadLinks.length === 0,
    `${nav.count} links, dead: ${JSON.stringify(deadLinks)}`,
  )
  check(
    'each route renders a heading matching its nav label',
    unheaded.length === 0 && mislabelled.length === 0,
    JSON.stringify(mislabelled.length > 0 ? mislabelled : unheaded),
  )
  check(
    'the active route is marked with aria-current',
    nav.visited.every((v) => v.current === 'page'),
    JSON.stringify(nav.visited.map((v) => [v.label, v.current])),
  )

  // An unknown path must land on the catch-all rather than a blank frame.
  const unknownRoute = await evaluate(
    window,
    `(async () => {
       window.location.hash = '#/nonexistent'
       await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
       const found = document.body.textContent.includes('Route not found')
       window.location.hash = '#/'
       await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
       return String(found)
     })()`,
  )
  check('an unknown path renders the catch-all route', unknownRoute === 'true', unknownRoute)

  // Collapsing must not drop the accessible name of a nav item.
  const collapsed = await evaluate(
    window,
    `(async () => {
       const toggle = document.querySelector('button[aria-label="Collapse sidebar"]')
       toggle.click()
       await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

       const links = [...document.querySelectorAll('nav[aria-label="Main"] a')]
       const named = links.every(
         (a) => (a.getAttribute('aria-label') ?? a.textContent.trim()).length > 0,
       )
       const width = document.querySelector('nav[aria-label="Main"]').offsetWidth

       document.querySelector('button[aria-label="Expand sidebar"]')?.click()
       await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

       return JSON.stringify({ named, width, count: links.length })
     })()`,
  )
  const col = JSON.parse(collapsed)
  check(
    'collapsed sidebar keeps every item named',
    col.named === true && col.width < 60 && col.count === 8,
    collapsed,
  )

  // Focus rings are an accessibility requirement, not a decoration.
  const focusRing = await evaluate(
    window,
    `(() => {
       // A button inside the shell, not merely the first in document order: a
       // closed <dialog> renders its children but they cannot take focus, so
       // querySelector('button') would pick an unfocusable one.
       const el = document.querySelector('header button')
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
