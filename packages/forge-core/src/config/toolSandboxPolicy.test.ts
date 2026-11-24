import { describe, it, expect } from 'vitest'
import {
  normalizeBinaryName,
  validateToolExecutionPolicy,
  type ToolSandboxPolicy,
} from './toolSandboxPolicy'

describe('toolSandboxPolicy (CONFIG-016)', () => {
  describe('normalizeBinaryName', () => {
    it('normalizes Windows and Unix binary paths and extensions', () => {
      expect(normalizeBinaryName('git')).toBe('git')
      expect(normalizeBinaryName('C:\\Program Files\\Git\\bin\\git.exe')).toBe('git')
      expect(normalizeBinaryName('/usr/local/bin/node')).toBe('node')
      expect(normalizeBinaryName('build.CMD')).toBe('build')
      expect(normalizeBinaryName('')).toBe('')
    })
  })

  describe('validateToolExecutionPolicy', () => {
    const policy: ToolSandboxPolicy = {
      defaultAction: 'block',
      allowedBinaries: ['git', 'npm', 'vitest'],
      rules: [
        {
          binary: 'git',
          allowedSubcommands: ['status', 'diff', 'log', 'show', 'commit'],
          prohibitedFlags: ['--no-verify', '--force', '-f', '--hard'],
        },
        {
          binary: 'npm',
          allowedSubcommands: ['test', 'run', 'list'],
          prohibitedFlags: ['--unsafe-perm'],
        },
      ],
    }

    it('allows valid execution matching allowed binaries and subcommands', () => {
      const result = validateToolExecutionPolicy('git', ['status', '--short'], policy)
      expect(result.allowed).toBe(true)
      expect(result.violationKind).toBeUndefined()
      expect(result.formattedSummary).toContain('[Tool Policy Permitted]')
    })

    it('blocks prohibited flags (e.g. --no-verify, --force)', () => {
      const result = validateToolExecutionPolicy(
        'git',
        ['commit', '-m', 'skip checks', '--no-verify'],
        policy,
      )
      expect(result.allowed).toBe(false)
      expect(result.violationKind).toBe('prohibited_flag')
      expect(result.reason).toContain('--no-verify')
      expect(result.formattedSummary).toContain('[Tool Policy Denied]')
    })

    it('blocks forbidden subcommands outside the allowed list', () => {
      const result = validateToolExecutionPolicy('git', ['push', 'origin', 'main'], policy)
      expect(result.allowed).toBe(false)
      expect(result.violationKind).toBe('forbidden_subcommand')
      expect(result.reason).toContain('push')
    })

    it('blocks execution when required subcommand is missing', () => {
      const result = validateToolExecutionPolicy('git', [], policy)
      expect(result.allowed).toBe(false)
      expect(result.violationKind).toBe('forbidden_subcommand')
    })

    it('blocks forbidden binaries not in whitelist when defaultAction is block', () => {
      const result = validateToolExecutionPolicy('curl', ['https://example.com'], policy)
      expect(result.allowed).toBe(false)
      expect(result.violationKind).toBe('forbidden_binary')
    })

    it('enforces allowedFlags restriction when allowArbitraryArgs is false', () => {
      const strictPolicy: ToolSandboxPolicy = {
        defaultAction: 'allow',
        rules: [
          {
            binary: 'vitest',
            allowedFlags: ['--run', '--coverage'],
            allowArbitraryArgs: false,
          },
        ],
      }

      const allowedRes = validateToolExecutionPolicy('vitest', ['--run'], strictPolicy)
      expect(allowedRes.allowed).toBe(true)

      const blockedRes = validateToolExecutionPolicy('vitest', ['--inspect-brk'], strictPolicy)
      expect(blockedRes.allowed).toBe(false)
      expect(blockedRes.violationKind).toBe('prohibited_flag')
    })

    it('rejects empty binary name', () => {
      const result = validateToolExecutionPolicy('', [], policy)
      expect(result.allowed).toBe(false)
      expect(result.violationKind).toBe('forbidden_binary')
    })
  })
})
