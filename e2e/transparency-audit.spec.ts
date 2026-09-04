import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * Drives Forge exactly as a user does, and records what the app *showed* at each
 * moment rather than what it did internally.
 *
 * Separate from `app.spec.ts` because this is an observation harness, not a gate: it
 * spawns real CLIs, costs real turns, and its output is a report for a human to read.
 * It is skipped unless FORGE_AUDIT=1 so it can live in the repository without running
 * in CI.
 *
 * Transparency is scored from the renderer only. A step whose progress is visible in
 * the app scores high; a step Forge performs silently scores low even when the
 * underlying work is correct, because the question being asked is "can the user see
 * what is happening", not "did it happen".
 */

const TARGET = process.env.FORGE_AUDIT_REPO ?? 'D:/my-quests/side-projects/foldervault'
const TITLE = 'search for any vulnerabilities'
const REQ =
  'search for any vulnerabilities, and group and categorize them with their severity Level, and pin point the location, and best possible solution'

const OUT = 'audit-out'
const SHOTS = join(OUT, 'frames')
const LOG = join(OUT, 'timeline.jsonl')

interface Frame {
  readonly t: number
  readonly label: string
  readonly stageSummary: string
  readonly visibleAgents: string
  readonly bodyChars: number
}

let app: ElectronApplication
let page: Page
let t0 = 0
const frames: Frame[] = []
const marks: { readonly label: string; readonly at: number }[] = []

const now = (): number => Date.now() - t0
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

const record = (event: Record<string, unknown>): void => {
  appendFileSync(LOG, `${JSON.stringify({ t: now(), ...event })}\n`, 'utf8')
}

const mark = (label: string): void => {
  marks.push({ label, at: now() })
  record({ kind: 'mark', label })
}

/** A frame is a screenshot plus the text that was on screen when it was taken. */
const frame = async (label: string): Promise<string> => {
  const body = await page.locator('body').innerText()
  await page.screenshot({
    path: join(SHOTS, `${String(frames.length).padStart(3, '0')}-${label}.png`),
  })

  const stageSummary = body
    .split('\n')
    .filter((l) => /STAGE|PASS|FAIL|VERIFYING|PLANNING|RUNNING|Halted|Iteration/.test(l))
    .join(' | ')
    .slice(0, 240)
  const visibleAgents = body
    .split('\n')
    .filter((l) => /claude-cli|antigravity-cli|mock:default/.test(l))
    .join(',')
    .slice(0, 160)

  frames.push({ t: now(), label, stageSummary, visibleAgents, bodyChars: body.length })
  record({ kind: 'frame', label, stageSummary, visibleAgents })
  return body
}

const git = (args: readonly string[]): string => {
  try {
    return execFileSync('git', [...args], { cwd: TARGET, encoding: 'utf8' })
  } catch {
    return '<git failed>'
  }
}

test.describe('workflow transparency audit', () => {
  // Playwright has no `describe.skipIf` (that is vitest's API); a conditional
  // `test.skip` at suite scope is the equivalent, and it keeps the hooks from
  // launching Electron when the audit is not being run.
  test.skip(process.env.FORGE_AUDIT !== '1', 'set FORGE_AUDIT=1 to run the audit')

  test.beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true })
    writeFileSync(LOG, '', 'utf8')
    t0 = Date.now()

    const userDataDir = mkdtempSync(join(tmpdir(), 'forge-audit-'))
    app = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`, '--disable-gpu'],
      env: { ...process.env, NODE_ENV: 'production' },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    page.on('console', (m) => {
      if (m.type() === 'error') record({ kind: 'console-error', text: m.text().slice(0, 300) })
    })
    page.on('pageerror', (e) => {
      record({ kind: 'page-error', text: e.message.slice(0, 300) })
    })
  })

  test.afterAll(async () => {
    await app?.close()
  })

  test('drive a real two-provider workflow and audit what the UI reveals', async () => {
    test.setTimeout(3_000_000)

    const before = git(['status', '--porcelain'])
    record({ kind: 'repo-before', dirty: before.trim() !== '', raw: before.slice(0, 400) })

    // ---------- 1. launch ----------
    mark('app-launched')
    await frame('01-launch')

    // ---------- 2. create project ----------
    await page.getByRole('button', { name: /new/i }).first().click()
    await page.waitForTimeout(900)
    await frame('02-create-dialog')

    await page.getByLabel(/name/i).first().fill('foldervault')
    await page
      .getByLabel(/repository/i)
      .first()
      .fill(TARGET)
    await page.waitForTimeout(2600)
    await frame('03-repo-probed')

    await page.getByRole('button', { name: /^create$/i }).click({ timeout: 20_000 })
    await page.waitForTimeout(4200)
    mark('project-created')
    await frame('04-project-created')

    // ---------- 3. bind real runtimes ----------
    await page.getByText('Agents', { exact: false }).first().click()
    await page.waitForTimeout(3000)
    await frame('05-agents-before-binding')

    const want: Record<number, string> = {
      5: 'claude-cli',
      6: 'antigravity-cli',
      7: 'claude-cli',
    }
    for (const idx of [5, 6, 7]) {
      await page.getByRole('button').nth(idx).click()
      await page.waitForTimeout(1100)
      await page
        .locator('[role=option]')
        .filter({ hasText: want[idx] as string })
        .first()
        .click()
      await page.waitForTimeout(1400)
    }
    mark('runtimes-bound')
    const bound = await frame('06-agents-bound')
    record({
      kind: 'bindings',
      lines: bound
        .split('\n')
        .filter((l) => /Current Engine|Engine:/.test(l))
        .join(' | '),
    })

    // ---------- 4. choose the template ----------
    await page.getByText('Workflows', { exact: false }).first().click()
    await page.waitForTimeout(2600)
    await frame('07-launchpad')

    // Resolved by the card's own 'ID: <template>' text rather than by position. An
    // earlier harness used nth(2), which is Refactor — the mismatch it reported as a
    // product bug was its own off-by-one.
    const btns = page.getByRole('button', { name: /start work/i })
    const total = await btns.count()
    let target = 2
    for (let i = 0; i < total; i += 1) {
      const hit = await btns.nth(i).evaluate((b) => {
        let el: HTMLElement | null = b as HTMLElement
        for (let up = 0; up < 6 && el !== null; up += 1) {
          if (/ID:\s*security/.test(el.innerText ?? '')) return true
          el = el.parentElement
        }
        return false
      })
      if (hit) {
        target = i
        break
      }
    }
    record({ kind: 'security-card-index', index: target })
    const startBtn = btns.nth(target)
    await startBtn.click({ timeout: 20_000 })
    await page.waitForTimeout(2100)

    const dialog = await frame('08-start-dialog')
    const preselected = dialog
      .split('\n')
      .find((l) => /—/.test(l) && /Refactor|Security|Bug|Feature|Test/.test(l))
    record({ kind: 'template-preselected', value: preselected ?? 'n/a' })

    // ---------- 5. fill the form ----------
    const fields = page.locator('input:visible, textarea:visible')
    await fields.nth(0).fill(TITLE)
    await fields.nth(1).fill(REQ)
    await page.waitForTimeout(700)
    await frame('09-form-filled')

    await page.getByRole('button', { name: /start planning/i }).click({ timeout: 20_000 })
    mark('workflow-started')
    await frame('10-started')

    // ---------- 6. observe every stage transition ----------
    let lastSummary = ''
    let idx = 11
    for (let i = 0; i < 260; i += 1) {
      await page.waitForTimeout(5000)

      let body: string
      try {
        body = await page.locator('body').innerText()
      } catch {
        record({ kind: 'window-closed' })
        break
      }

      const summary = body
        .split('\n')
        .filter((l) => /STAGE|PASS|FAIL|VERIFYING|Halted|Iteration|RUNNING/.test(l))
        .join(' | ')
        .slice(0, 240)

      // A frame per *change*, so the report shows transitions rather than a fixed cadence.
      if (summary !== lastSummary) {
        lastSummary = summary
        await frame(`${String(idx).padStart(2, '0')}-transition`)
        idx += 1

        const worktrees = git(['worktree', 'list'])
        record({
          kind: 'stage-change',
          summary,
          repoDirty: git(['status', '--porcelain']).trim() !== '',
          worktreeCount: worktrees.split('\n').filter((l) => l.trim() !== '').length,
        })
      }

      if (/Halted|Workflow complete|DONE/.test(body)) {
        mark('workflow-terminal')
        break
      }
    }

    await frame('99-final')

    // ---------- 7. what the log stream exposed ----------
    try {
      await page
        .getByText(/Protocol Log Stream/i)
        .first()
        .click()
      await page.waitForTimeout(1600)
      const protocolBody = await frame('98-protocol-log')
      record({ kind: 'protocol-log', chars: protocolBody.length })
    } catch {
      record({ kind: 'protocol-log-unavailable' })
    }

    const after = git(['status', '--porcelain'])
    record({
      kind: 'repo-after',
      dirty: after.trim() !== '',
      raw: after.slice(0, 400),
      worktrees: git(['worktree', 'list']),
    })

    // ---------- 8. timing table ----------
    const timings = marks.map((m, i) => ({
      phase: m.label,
      at: secs(m.at),
      took: i === 0 ? '-' : secs(m.at - (marks[i - 1]?.at ?? 0)),
    }))
    record({ kind: 'timings', timings })

    console.log('\n================ PHASE TIMINGS ================')
    for (const row of timings)
      console.log(`${row.phase.padEnd(24)} at ${row.at.padStart(8)}  (+${row.took})`)

    console.log('\n================ UI FRAMES ================')
    for (const f of frames) {
      console.log(
        `[${secs(f.t).padStart(8)}] ${f.label.padEnd(24)} agents=${f.visibleAgents || '-'}`,
      )
      if (f.stageSummary !== '') console.log(`           ${f.stageSummary}`)
    }

    console.log(`\nframes=${String(frames.length)}  timeline=${LOG}`)
  })
})
