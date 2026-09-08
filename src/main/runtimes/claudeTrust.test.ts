import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../test/tempDir'
import { ClaudeTrustStore } from './claudeTrust'

/**
 * The config under test belongs to the user's CLI, so every assertion here is
 * really about not damaging it. A blind write would cost the user their
 * onboarding state, caches, and 85 project entries — measured on this machine.
 */
const dirs: string[] = []

const makeConfig = (contents: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-trust-'))
  dirs.push(dir)
  const path = join(dir, '.claude.json')
  writeFileSync(path, JSON.stringify(contents, null, 2), 'utf8')
  return path
}

const read = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir)
})

describe('ClaudeTrustStore', () => {
  it('records trust for a path the config has never seen', async () => {
    const configPath = makeConfig({ projects: {} })

    expect(await new ClaudeTrustStore({ configPath }).trust('D:\\work\\wt-1')).toBe(true)

    const projects = read(configPath).projects as Record<string, Record<string, unknown>>
    // Forward slashes: measured from a real config, that is the form the CLI
    // stores. A backslash key would never match and the dialog would still fire.
    expect(projects['D:/work/wt-1']?.hasTrustDialogAccepted).toBe(true)
  })

  it('leaves every other project entry untouched', async () => {
    const configPath = makeConfig({
      projects: {
        'D:/existing': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] },
        'D:/other': { hasTrustDialogAccepted: false },
      },
    })

    await new ClaudeTrustStore({ configPath }).trust('D:/new')

    const projects = read(configPath).projects as Record<string, Record<string, unknown>>
    expect(Object.keys(projects).sort()).toEqual(['D:/existing', 'D:/new', 'D:/other'])
    expect(projects['D:/existing']?.allowedTools).toEqual(['Bash'])
    // An untrusted entry must not be silently flipped: Forge trusts the worktree
    // it created, not every folder the user has ever opened.
    expect(projects['D:/other']?.hasTrustDialogAccepted).toBe(false)
  })

  it('preserves the config keys it does not understand', async () => {
    // The real file carries ~70 top-level keys — onboarding flags, caches, the
    // OAuth account. Anything dropped here is data the user loses.
    const configPath = makeConfig({
      numStartups: 42,
      oauthAccount: { emailAddress: 'someone@example.com' },
      projects: {},
    })

    await new ClaudeTrustStore({ configPath }).trust('D:/wt')

    const after = read(configPath)
    expect(after.numStartups).toBe(42)
    expect(after.oauthAccount).toEqual({ emailAddress: 'someone@example.com' })
  })

  it('keeps a project\u2019s own settings when marking it trusted', async () => {
    const configPath = makeConfig({
      projects: { 'D:/wt': { allowedTools: ['Read'], mcpServers: { local: {} } } },
    })

    await new ClaudeTrustStore({ configPath }).trust('D:/wt')

    const entry = (read(configPath).projects as Record<string, Record<string, unknown>>)['D:/wt']
    expect(entry?.hasTrustDialogAccepted).toBe(true)
    expect(entry?.allowedTools).toEqual(['Read'])
    expect(entry?.mcpServers).toEqual({ local: {} })
  })

  it('is idempotent for a path already trusted', async () => {
    const configPath = makeConfig({ projects: { 'D:/wt': { hasTrustDialogAccepted: true } } })
    const before = readFileSync(configPath, 'utf8')

    expect(await new ClaudeTrustStore({ configPath }).trust('D:/wt')).toBe(true)
    expect(readFileSync(configPath, 'utf8')).toBe(before)
  })

  it('reports failure instead of throwing when the config is missing', async () => {
    // Not fatal: the caller still launches and the user answers the dialog once.
    // Throwing would turn a cosmetic problem into a failed run.
    const store = new ClaudeTrustStore({ configPath: join(tmpdir(), 'forge-absent-config.json') })
    expect(await store.trust('D:/wt')).toBe(false)
  })

  it('reports failure instead of throwing on a corrupt config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-trust-'))
    dirs.push(dir)
    const configPath = join(dir, '.claude.json')
    writeFileSync(configPath, '{ not json', 'utf8')

    expect(await new ClaudeTrustStore({ configPath }).trust('D:/wt')).toBe(false)
    // The unreadable file is left exactly as found rather than overwritten: it
    // may be recoverable, and Forge did not write it.
    expect(readFileSync(configPath, 'utf8')).toBe('{ not json')
  })

  it('leaves no temporary file behind', async () => {
    const configPath = makeConfig({ projects: {} })
    await new ClaudeTrustStore({ configPath }).trust('D:/wt')

    const dir = configPath.slice(0, configPath.lastIndexOf('\\') + 1) || tmpdir()
    expect(readdirSync(dir).filter((f) => f.includes('.forge-'))).toEqual([])
  })
})
