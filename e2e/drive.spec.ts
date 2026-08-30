import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, test, type ElectronApplication, type Page } from '@playwright/test'

const TARGET = 'D:/my-quests/side-projects/foldervault'
const TITLE = 'search for any vulnerabilities'
const REQ = 'search for any vulnerabilities, and group and categorize them with their severity Level, and pin point the location, and best possible solution'
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'forge-drive-'))
  app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`, '--disable-gpu'], env: { ...process.env, NODE_ENV: 'production' } })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
})
test.afterAll(async () => { await app?.close() })

test('isolated real run', async () => {
  test.setTimeout(2_400_000)

  await page.getByRole('button', { name: /new/i }).first().click()
  await page.waitForTimeout(800)
  await page.getByLabel(/name/i).first().fill('foldervault')
  await page.getByLabel(/repository/i).first().fill(TARGET)
  await page.waitForTimeout(2500)
  await page.getByRole('button', { name: /^create$/i }).click({ timeout: 20_000 })
  await page.waitForTimeout(4000)

  await page.getByText('Agents', { exact: false }).first().click()
  await page.waitForTimeout(3000)
  const want: Record<number, string> = { 5: 'claude-cli', 6: 'antigravity-cli', 7: 'claude-cli' }
  for (const idx of [5, 6, 7]) {
    await page.getByRole('button').nth(idx).click()
    await page.waitForTimeout(1200)
    await page.locator('[role=option]').filter({ hasText: want[idx] as string }).first().click()
    await page.waitForTimeout(1500)
  }
  const ab = await page.locator('body').innerText()
  console.log('=== BINDINGS ===')
  console.log(ab.split('\n').filter((l) => /Current Engine|Engine:/.test(l)).join('\n'))

  await page.getByText('Workflows', { exact: false }).first().click()
  await page.waitForTimeout(2500)
  await page.getByRole('button', { name: /start work/i }).nth(2).click({ timeout: 20_000 })
  await page.waitForTimeout(2000)
  const tmplLine = (await page.locator('body').innerText()).split('\n').find((l) => /—/.test(l) && /Refactor|Security|Bug|Feature|Test/.test(l))
  console.log(`=== TEMPLATE PRESELECTED: ${tmplLine ?? 'n/a'} ===`)

  const fields = page.locator('input:visible, textarea:visible')
  await fields.nth(0).fill(TITLE)
  await fields.nth(1).fill(REQ)
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: /start planning/i }).click({ timeout: 20_000 })
  console.log('[ok] started')

  let last = ''
  for (let i = 0; i < 200; i += 1) {
    await page.waitForTimeout(6000)
    const t = await page.locator('body').innerText()
    const line = t.split('\n').filter((l) => /Halted|Iteration|Result:|VERIFICATION|STAGE START|DONE|complete/.test(l)).slice(-4).join(' ~ ').slice(0, 300)
    if (line !== last) { console.log(`[t=${i * 6}s] ${line}`); last = line }
    if (/Halted|Workflow complete|DONE/.test(t)) { console.log(`[stop] ${i * 6}s`); break }
  }
  await page.screenshot({ path: 'drive-out/final.png' })
  const fin = await page.locator('body').innerText()
  console.log('\n===== FINAL =====\n' + fin.slice(0, 5000))
})
