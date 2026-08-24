import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../test/tempDir'
import { AccountHomes } from './accountHomes'
import { EnrollmentService } from './enrollmentService'
import { AntigravityCliRuntime } from '../runtimes/antigravityCliRuntime'
import { ClaudeCliRuntime } from '../runtimes/claudeCliRuntime'
import { RuntimeRegistry } from '../runtimes/registry'

/**
 * Enrolling an account, and refusing to pretend when it cannot be isolated.
 *
 * Forge never handles a credential here, so what is under test is the boundary: which
 * runtimes may hold several accounts, and what Forge is willing to claim about one.
 */

let root: string
let registry: RuntimeRegistry

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forge-enrol-'))
  registry = new RuntimeRegistry()
  registry.register(new ClaudeCliRuntime())
  registry.register(new AntigravityCliRuntime())
})

afterEach(async () => {
  await removeTempDir(root)
})

function service(): EnrollmentService {
  // Points at Node rather than a real CLI: these assert Forge's own decisions, and a
  // test that needed a vendor login could not run in CI at all.
  return new EnrollmentService(new AccountHomes(root), registry, () => process.execPath)
}

describe('EnrollmentService', () => {
  it('prepares an isolated home for a runtime that supports it', async () => {
    const home = await service().prepare('claude-cli', 'acct-1')

    expect(home).toContain('acct-1')
  })

  it('refuses to enrol a second account against a runtime that cannot isolate', async () => {
    // Antigravity's credential is in the Windows Credential Manager under one fixed
    // name (#111), so a per-account home would isolate nothing. Accepting the request
    // would give the user two names for one identity — work would appear to run in
    // parallel while sharing a single account's quota, with no visible cause.
    await expect(service().prepare('antigravity-cli', 'acct-2')).rejects.toThrow(
      /cannot hold more than one account/,
    )
  })

  it('reports an unenrolled account as not logged in, with no home', async () => {
    const status = await service().status('claude-cli', 'never-enrolled')

    expect(status.isolatable).toBe(true)
    expect(status.home).toBeNull()
    expect(status.auth.loggedIn).toBe(false)
  })

  it('reports a non-isolating runtime as such rather than as unenrolled', async () => {
    // These are different problems with different remedies: one is "sign in", the
    // other is "this platform cannot do what you asked".
    const status = await service().status('antigravity-cli', 'acct-1')

    expect(status.isolatable).toBe(false)
    expect(status.home).toBeNull()
  })

  it('hands back the login command instead of running it', async () => {
    const home = await service().prepare('claude-cli', 'acct-1')
    const enrol = service().enrollmentCommand('claude-cli', home)

    // Returned, not executed: the login opens a browser and needs a terminal the user
    // can see, and Forge must never be positioned to intercept what is typed there.
    expect(enrol.args).toEqual(['auth', 'login'])
    expect(enrol.env.HOME).toBe(home)
    expect(enrol.env.USERPROFILE).toBe(home)
  })

  it('revokes by deleting the home, because that is all there is', async () => {
    const homes = new AccountHomes(root)
    await homes.ensure('acct-1')

    await service().revoke('acct-1')

    await expect(homes.exists('acct-1')).resolves.toBe(false)
  })

  it('treats an unknown runtime as unable to isolate', async () => {
    // A2: an unregistered runtime is an unknown, and an unknown must not be assumed
    // capable of keeping accounts apart.
    const status = await service().status('not-registered', 'acct-1')

    expect(status.isolatable).toBe(false)
  })
})
