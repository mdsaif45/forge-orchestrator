import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
    keys: Object.keys(window.forge).sort(),
    app: Object.keys(window.forge.app),
    invoke: typeof (window.forge as unknown as Record<string, unknown>)['invoke'],
    send: typeof (window.forge as unknown as Record<string, unknown>)['send'],
  }))

  // Named methods only, and no generic passthrough: the renderer must not be able
  // to name a channel. `scripts/smoke.cjs` additionally asserts that this surface
  // matches the contract exactly, which is what catches a channel with no method.
  expect(surface).toEqual({
    keys: ['app', 'dialog', 'project'],
    app: ['getInfo'],
    invoke: 'undefined',
    send: 'undefined',
  })
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

test('a project can be created, and survives a restart', async () => {
  // The definition of done for #18, driven through the real UI: fill the form,
  // create, then relaunch the app against the same profile and confirm the
  // project is still there. A unit test proves the store round-trips; only this
  // proves the app's own wiring does.
  const repo = mkdtempSync(join(tmpdir(), 'forge-e2e-repo-'))
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', '.'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# e2e\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'first'], { cwd: repo })

  // These tests share one app instance, and an earlier one leaves the router on
  // another route. Navigate explicitly rather than inheriting wherever it stopped.
  await page.getByRole('link', { name: 'Overview' }).click()

  await page.getByRole('button', { name: 'New project' }).click()

  // Forward slashes: git reports POSIX-style paths, and the domain's `repoPath`
  // refuses a backslash for exactly that reason.
  const repoPosix = repo.split('\\').join('/')

  await page.getByLabel('Name').fill('E2E Project')
  await page.getByLabel('Repository').fill(repoPosix)
  await page.getByLabel('Rules').fill('never modify migrations without approval')

  // Wait for the probe to resolve rather than for a fixed delay: Create stays
  // disabled until main confirms the folder is a repository.
  const create = page.getByRole('button', { name: 'Create' })
  await expect(create).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByText('Git repository')).toBeVisible()

  await create.click()

  // The switcher is the shell's own view of what exists, so seeing the name there
  // means the create round-tripped through main and was re-read.
  await expect(page.getByRole('combobox', { name: 'Active project' })).toHaveValue(/.+/)
  await expect(page.getByRole('heading', { name: 'E2E Project' })).toBeVisible()
  await expect(page.getByText('never modify migrations without approval')).toBeVisible()

  // Asserted against what main stored rather than against a path recomputed here.
  // Node's realpath resolves symlinks but does *not* expand 8.3 short names, while
  // `git rev-parse` answers with the long form — so on the Windows runner, whose
  // temp directory is `RUNNER~1`, the two disagree. Reading it back means the test
  // checks the real claim (the displayed path is the stored one) instead of
  // reimplementing main's normalisation and getting it wrong.
  const stored = await page.evaluate(async () => {
    const listed = await window.forge.project.list()
    return listed.ok ? (listed.value.projects.at(0)?.repository.absolutePath ?? '') : ''
  })

  expect(stored).not.toContain('\\')
  await expect(page.getByText(stored)).toBeVisible()

  // Relaunch against the same user data directory.
  await app.close()
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`, '--disable-gpu'],
    env: { ...process.env, NODE_ENV: 'production' },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: 'Overview' }).click()

  await expect(page.getByRole('heading', { name: 'E2E Project' })).toBeVisible({ timeout: 15_000 })
  // Rules are restored too, which means the rule events replayed and not just the
  // project row.
  await expect(page.getByText('never modify migrations without approval')).toBeVisible()

  rmSync(repo, { recursive: true, force: true })
})
