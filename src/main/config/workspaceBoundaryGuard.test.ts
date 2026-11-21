import { describe, it, expect } from 'vitest'
import { validateWorkspaceBoundary, assertWorkspaceBoundary } from './workspaceBoundaryGuard'

describe('WorkspaceBoundaryGuard (CONFIG-014)', () => {
  const root = 'D:\\projects\\my-app'

  it('allows safe relative paths inside workspace', () => {
    const res = validateWorkspaceBoundary('src/index.ts', root)
    expect(res.allowed).toBe(true)
    expect(res.violationKind).toBe('none')
    expect(res.formattedSummary).toContain('BOUNDARY ALLOWED')
  })

  it('allows subdirectories and nested paths', () => {
    const res = validateWorkspaceBoundary('packages/core/src/utils.ts', root)
    expect(res.allowed).toBe(true)
    expect(res.violationKind).toBe('none')
  })

  it('blocks empty paths', () => {
    const res = validateWorkspaceBoundary('   ', root)
    expect(res.allowed).toBe(false)
    expect(res.violationKind).toBe('traversal_escape')
  })

  it('blocks directory traversal attempts using ..', () => {
    const res = validateWorkspaceBoundary('../../etc/passwd', root)
    expect(res.allowed).toBe(false)
    expect(res.violationKind).toBe('traversal_escape')
    expect(res.reason).toContain('escapes workspace boundary')
  })

  it('blocks absolute paths outside workspace root', () => {
    const res = validateWorkspaceBoundary('C:\\Users\\admin\\secret.txt', root)
    expect(res.allowed).toBe(false)
    expect(res.violationKind).toBe('traversal_escape')

    const posixRes = validateWorkspaceBoundary('/etc/shadow', '/home/user/my-app')
    expect(posixRes.allowed).toBe(false)
    expect(posixRes.violationKind).toBe('traversal_escape')
  })

  it('blocks access to protected metadata and credential files (.git, .env, .ssh)', () => {
    const gitRes = validateWorkspaceBoundary('.git/config', root)
    expect(gitRes.allowed).toBe(false)
    expect(gitRes.violationKind).toBe('protected_directory')

    const envRes = validateWorkspaceBoundary('.env.production', root)
    expect(envRes.allowed).toBe(false)
    expect(envRes.violationKind).toBe('protected_directory')

    const sshRes = validateWorkspaceBoundary('.ssh/id_rsa', root)
    expect(sshRes.allowed).toBe(false)
    expect(sshRes.violationKind).toBe('protected_directory')
  })

  it('assertWorkspaceBoundary throws when violation occurs', () => {
    expect(() => {
      assertWorkspaceBoundary('../secret', root)
    }).toThrow(/escapes workspace boundary/i)
    expect(() => {
      assertWorkspaceBoundary('src/main.ts', root)
    }).not.toThrow()
  })
})
