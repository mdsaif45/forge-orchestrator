import Database from 'better-sqlite3'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'

/**
 * Launches the real app and drives it as a user would.
 *
 * This complements the dependency-free checks in `scripts/`: those assert the
 * process boundary and the design system in isolation, while these exercise the
 * app's own startup path — main creating the window, registering handlers, and
 * applying its security policy.
 */
let app: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
  // A throwaway profile per run, so persisted state from a previous run cannot
  // change what these tests observe.
  userDataDir = mkdtempSync(join(tmpdir(), 'forge-e2e-'))

  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`, '--disable-gpu'],
    env: { ...process.env, NODE_ENV: 'production' },
  })

  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app.close()
})

test('the app opens a window and renders the shell', async () => {
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
})

test('the renderer has no Node access', async () => {
  // Axiom A7, asserted against the app's own window rather than a test harness.
  const exposed = await page.evaluate(() => ({
    require: typeof (window as unknown as Record<string, unknown>)['require'],
    process: typeof (window as unknown as Record<string, unknown>)['process'],
  }))

  expect(exposed).toEqual({ require: 'undefined', process: 'undefined' })
})

test('the preload bridge exposes only named methods', async () => {
  const surface = await page.evaluate(() => ({
    keys: Object.keys(window.forge),
    app: Object.keys(window.forge.app),
    invoke: typeof (window.forge as unknown as Record<string, unknown>)['invoke'],
  }))

  expect(surface).toEqual({ keys: ['app'], app: ['getInfo'], invoke: 'undefined' })
})

test('app info resolves over the real IPC contract', async () => {
  // Proves main registered its handlers during startup, which the isolated
  // checks stub out.
  const result = await page.evaluate(() => window.forge.app.getInfo())

  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.value.name).toBe('Forge')
    expect(result.value.versions.electron).not.toBe('')
  }
})

test('every navigation item reaches a live route', async () => {
  const links = page.getByRole('navigation', { name: 'Main' }).getByRole('link')
  const labels = await links.allInnerTexts()

  expect(labels).toHaveLength(8)

  for (const label of labels) {
    await links.filter({ hasText: label }).click()

    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible()
    await expect(page.getByText('Route not found')).toBeHidden()
  }
})

test('the sidebar collapses without losing item names', async () => {
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()

  const links = page.getByRole('navigation', { name: 'Main' }).getByRole('link')
  await expect(links).toHaveCount(8)

  // Labels move into aria-label rather than disappearing.
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute('aria-label', /\w+/)
  }

  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible()
})

test('the app creates and migrates its database on startup', async () => {
  // Forge owns the project truth, so persistence existing is not optional. The
  // unit tests cover the migration logic; this asserts the real startup path ran
  // it — the app was launched, and the schema is on disk afterwards.
  const file = join(userDataDir, 'forge.db')
  expect(existsSync(file)).toBe(true)

  // Opened from the test process rather than through app.evaluate: the bundled
  // main process is ESM, so that context has neither `require` nor a dynamic
  // import callback. better-sqlite3 loads here for the same reason it loads in
  // Electron — it ships platform-keyed N-API prebuilds.
  const db = new Database(file, { readonly: true })

  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name)

    expect(tables).toContain('projects')
    expect(tables).toContain('events')
    expect(tables).toContain('workflows')
    // Created by the migration runner itself, so its presence proves migrations ran.
    expect(tables).toContain('schema_meta')
  } finally {
    db.close()
  }
})
