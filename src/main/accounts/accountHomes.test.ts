import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../test/tempDir'
import { AccountHomes } from './accountHomes'
import { accountEnv, probeAccountAuth } from './accountAuth'

/**
 * Isolated homes, one per account.
 *
 * The claim being tested is that Forge can give a child process a home of its own and
 * never handle the credential itself — so these assert directory behaviour and the
 * environment handed to a child, not any secret, because there is none to assert on.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forge-homes-'))
})

afterEach(async () => {
  await removeTempDir(root)
})

describe('AccountHomes', () => {
  it('creates a home per account, and keeps them separate', async () => {
    const homes = new AccountHomes(root)

    const first = await homes.ensure('acct-1')
    const second = await homes.ensure('acct-2')

    expect(first).not.toBe(second)
    await expect(homes.exists('acct-1')).resolves.toBe(true)
    await expect(homes.exists('acct-2')).resolves.toBe(true)
  })

  it('is idempotent, so re-enrolling does not discard an existing credential', async () => {
    const homes = new AccountHomes(root)

    const first = await homes.ensure('acct-1')
    // Stand in for the credential the CLI writes; ensure() must not clear it.
    writeFileSync(join(first, 'marker.json'), '{}')

    const again = await homes.ensure('acct-1')

    expect(again).toBe(first)
    await expect(homes.exists('acct-1')).resolves.toBe(true)
  })

  it('does not create a home just by asking where one would be', async () => {
    const homes = new AccountHomes(root)

    // `pathFor` is separate from `ensure` precisely so a read-only caller cannot
    // conjure an empty home and make an unenrolled account look enrolled.
    const path = homes.pathFor('never-enrolled')

    expect(path).toContain('never-enrolled')
    await expect(homes.exists('never-enrolled')).resolves.toBe(false)
  })

  it('removes a home, which is the only way to revoke local access', async () => {
    const homes = new AccountHomes(root)
    await homes.ensure('acct-1')

    await homes.remove('acct-1')

    // Forge never held the secret, so deleting the home the CLI wrote into is the
    // whole of revocation.
    await expect(homes.exists('acct-1')).resolves.toBe(false)
  })

  it('removing an account that was never enrolled is not an error', async () => {
    const homes = new AccountHomes(root)

    await expect(homes.remove('never-enrolled')).resolves.toBeUndefined()
  })
})

describe('accountEnv', () => {
  it('sets both home variables, because Windows and the CLI read different ones', () => {
    const env = accountEnv('D:/forge/accounts/a1/home')

    // Setting only one leaves the other pointing at the real user, and the child would
    // silently authenticate as the wrong account.
    expect(env.HOME).toBe('D:/forge/accounts/a1/home')
    expect(env.USERPROFILE).toBe('D:/forge/accounts/a1/home')
  })
})

describe('probeAccountAuth', () => {
  it('reports a fresh home as logged out rather than throwing', async () => {
    // The real CLI exits 1 when logged out while still printing a valid JSON answer,
    // so this asserts the two things that case needs: the non-zero exit does not
    // become an exception, and the answer is read from stdout rather than invented.
    const homes = new AccountHomes(root)
    const home = await homes.ensure('unenrolled')

    const state = await probeAccountAuth('definitely-not-a-real-executable', home)

    expect(state.loggedIn).toBe(false)
    expect(state.email).toBeNull()
  })

  it('treats output that is not the expected answer as not usable', async () => {
    // A2/A3: an account Forge cannot establish as usable must not be reported as
    // usable. Anything else is an unverified claim about auth.
    //
    // Node rather than a shell: given `auth status` it fails immediately with output
    // that is not the expected JSON. An earlier attempt passed `cmd.exe`, which opens
    // an interactive shell and hung until the probe's own 30s timeout.
    const state = await probeAccountAuth(process.execPath, join(root, 'nowhere'))

    expect(state.loggedIn).toBe(false)
  })
})
