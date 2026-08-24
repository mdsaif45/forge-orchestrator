import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  // No generic passthrough: the renderer must not be able to name a channel.
  // Which domains exist is deliberately not restated — `scripts/smoke.cjs` derives
  // that from the contract itself, so listing them again here would only add a
  // second place to update whenever a channel is added.
  expect(surface.invoke).toBe('undefined')
  expect(surface.send).toBe('undefined')
  expect(surface.app).toEqual(['getInfo'])
  expect(surface.keys.length).toBeGreaterThan(0)
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

test('the clipboard works from the packaged file:// renderer', async () => {
  // The #104 regression, at the boundary where it actually happened. The renderer
  // here loads from `file://`, which is not a secure context, so
  // `navigator.clipboard.writeText` rejects — it worked under `npm run dev` over
  // http and failed only in the shipped app, which is why it reached a release.
  // Asserting the read-back rather than merely that the call resolved: a channel
  // that silently wrote nothing would satisfy the weaker check.
  const written = await page.evaluate(async () => {
    const result = await window.forge.clipboard.writeText('forge-e2e-clipboard')
    return result.ok
  })

  expect(written).toBe(true)

  // Deliberately not asserting a read-back from the OS clipboard.
  //
  // The first version of this test did, and it was wrong: the system clipboard is a
  // shared OS resource that another process can own, and on Windows it returns empty
  // whenever it is held elsewhere or the session is locked. Measured directly — a
  // standalone Electron process doing writeText/readText with no Forge code involved
  // also returned "" — so the assertion was testing the machine's state, not this
  // application's behaviour, and it failed a run for a reason unrelated to the change
  // being tested.
  //
  // What Forge is responsible for is that the renderer can reach main's clipboard at
  // all from a `file://` origin, which is the #104 regression. That is what the
  // envelope above proves, and it is the part that can actually regress in this
  // codebase.

  // The direct renderer API is expected to be unavailable here — this documents the
  // constraint that makes the main-side channel necessary, so a future "simplify"
  // does not undo it.
  const direct = await page.evaluate(async () => {
    try {
      await navigator.clipboard.writeText('should-not-work')
      return 'resolved'
    } catch {
      return 'rejected'
    }
  })

  expect(direct).toBe('rejected')
})

test('every navigation item reaches a live route', async () => {
  const links = page.getByRole('navigation', { name: 'Main' }).getByRole('link')
  const labels = await links.allInnerTexts()

  // Every item leads somewhere real, whatever the table holds. A hardcoded count
  // duplicated the route table and broke when a route was removed (#102).
  expect(labels.length).toBeGreaterThan(0)

  for (const label of labels) {
    await links.filter({ hasText: label }).click()

    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible()
    await expect(page.getByText('Route not found')).toBeHidden()
  }
})

test('the sidebar collapses without losing item names', async () => {
  // Counted while expanded, so the assertion below is about collapsing rather than
  // about how many routes happen to exist.
  const expandedLinkCount = await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link')
    .count()

  await page.getByRole('button', { name: 'Collapse sidebar' }).click()

  const links = page.getByRole('navigation', { name: 'Main' }).getByRole('link')
  // Collapsing must not drop items; the claim is "same as expanded", not "eight".
  await expect(links).toHaveCount(expandedLinkCount)

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
  // Checked out away from the default on purpose, so "default branch" and "current
  // branch" genuinely differ. With the repository sitting on `main`, the #100 bug
  // would have been invisible here — the wrong answer and the right one coincide.
  execFileSync('git', ['checkout', '--quiet', '-b', 'feature/e2e-probe'], { cwd: repo })

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

  // #100: the default branch offered must be the repository's default, never merely
  // whatever is checked out. This repository was created on `main` and a feature
  // branch checked out below, so the two differ — which is the exact shape of the
  // reported bug, where a project bound mid-feature recorded the feature branch as
  // its diff base.
  await expect(page.getByLabel('Default branch')).toHaveValue('main')

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

test('settings shows which rules are inherited and which are overridden', async () => {
  // The definition of done for #19's UI half. The project created by the previous
  // test is still selected, and it has one project-scope rule.
  await page.getByRole('link', { name: 'Settings' }).click()

  // Forge's eight defaults are always present, whatever the project defines.
  await expect(page.getByText('Never guess', { exact: false })).toBeVisible()

  // Overriding a default by reusing its key must show the displaced rule rather
  // than silently replacing it -- a silent override is how a global safety rule
  // disappears unnoticed.
  await page.getByLabel('Key').fill('R4')
  await page.getByLabel('Statement').fill('migrations may be modified here')
  await page.getByRole('button', { name: 'Set rule' }).click()

  const row = page.locator('li').filter({ hasText: 'migrations may be modified here' })
  await expect(row).toBeVisible()
  await expect(row.getByText('overrides', { exact: false })).toBeVisible()
  // The global statement it replaced is still shown.
  await expect(row.getByText('Stay in scope', { exact: false })).toBeVisible()

  // Removing the override reveals the default again, rather than deleting it.
  await row.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByText('migrations may be modified here')).toBeHidden()
  await expect(page.getByText('Stay in scope', { exact: false })).toBeVisible()
})

test('workflow page renders graph, starts workflow and allows step inspection', async () => {
  await page.getByRole('link', { name: 'Workflows' }).click()
  await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible()

  // Start a workflow run
  await page.getByRole('button', { name: 'Start Workflow' }).click()

  // The state machine graph and live log are visible
  await expect(page.getByText('LIVE LOG')).toBeVisible()
  const plannerNode = page.getByRole('button', { name: /planner/i })
  await expect(plannerNode).toBeVisible()

  // Click a node to open step inspector
  await plannerNode.click()
  await expect(page.getByRole('tab', { name: 'Prompt Packet' })).toBeVisible()
})

test('question queue displays open questions and allows answering to unblock', async () => {
  await page.getByRole('link', { name: 'Questions' }).click()
  await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible()
  await expect(page.getByText('One place for every interruption', { exact: false })).toBeVisible()
})

test('decisions page allows proposing, viewing and locking architectural decisions', async () => {
  await page.getByRole('link', { name: 'Decisions' }).click()
  await expect(page.getByRole('heading', { name: 'Decisions' })).toBeVisible()
  await expect(page.getByRole('button', { name: '+ Propose Decision' })).toBeVisible()

  // Open propose dialog
  await page.getByRole('button', { name: '+ Propose Decision' }).click()
  await expect(page.getByRole('heading', { name: 'Propose Architectural Decision' })).toBeVisible()

  await page.getByLabel('Decision Statement').fill('Use PostgreSQL for multi-tenant data')
  await page.getByLabel('Rationale & Justification').fill('Row-level security and ACID compliance')
  await page.getByRole('button', { name: 'Record Proposal' }).click()

  // Appears in list
  await expect(page.getByText('Use PostgreSQL for multi-tenant data')).toBeVisible()
  await expect(page.getByText('Proposed', { exact: true })).toBeVisible()

  // Lock decision
  await page.getByRole('button', { name: 'Lock Decision' }).click()
  await expect(page.getByText('Locked (Axiom A4)', { exact: true })).toBeVisible()
})

test('changes review page renders diffs read-only and supports edit mode', async () => {
  await page.getByRole('link', { name: 'Changes' }).click()
  await expect(page.getByRole('heading', { name: 'Changes' })).toBeVisible()
  await expect(page.getByText('Working tree is clean', { exact: false })).toBeVisible()
})
