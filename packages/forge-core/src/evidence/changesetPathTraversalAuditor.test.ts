import { describe, expect, it } from 'vitest'
import { auditChangesetPaths } from './changesetPathTraversalAuditor'

describe('ChangesetPathTraversalAuditor (EVIDENCE-018)', () => {
  it('passes clean relative paths within workspace bounds', () => {
    const safePaths = [
      'src/main/index.ts',
      'docs/README.md',
      'package.json',
      'src/renderer/components/Button.tsx',
    ]

    const report = auditChangesetPaths(safePaths)
    expect(report.isSafe).toBe(true)
    expect(report.violationCount).toBe(0)
    expect(report.violations.length).toBe(0)
    expect(report.summary).toContain('PATH SECURITY AUDIT PASSED')
  })

  it('rejects directory traversal escapes (../, ..\\, %2e%2e)', () => {
    const maliciousPaths = [
      'src/../../etc/passwd',
      'docs/..\\..\\Windows\\System32\\cmd.exe',
      'app/%2e%2e/secret.txt',
    ]

    const report = auditChangesetPaths(maliciousPaths)
    expect(report.isSafe).toBe(false)
    expect(report.highestSeverity).toBe('CRITICAL')
    expect(report.violations.every((v) => v.violationType === 'DIRECTORY_TRAVERSAL')).toBe(true)
  })

  it('rejects absolute paths and Windows UNC network share paths fail-closed', () => {
    const escapePaths = [
      '/etc/shadow',
      'C:\\Windows\\System32\\drivers',
      '\\\\attacker-smb\\payload\\exploit.js',
      '//malicious-host/share/data',
    ]

    const report = auditChangesetPaths(escapePaths)
    expect(report.isSafe).toBe(false)
    expect(report.highestSeverity).toBe('CRITICAL')
    const types = report.violations.map((v) => v.violationType)
    expect(types).toContain('ABSOLUTE_PATH_ESCAPE')
    expect(types).toContain('UNC_PATH_ESCAPE')
  })

  it('detects null byte injection attacks in filenames', () => {
    const nullBytePaths = ['src/safe.ts\0.exe', 'docs/secret.txt%00.png']

    const report = auditChangesetPaths(nullBytePaths)
    expect(report.isSafe).toBe(false)
    expect(report.highestSeverity).toBe('CRITICAL')
    expect(report.violations.every((v) => v.violationType === 'NULL_BYTE_INJECTION')).toBe(true)
  })

  it('flags forbidden executable extensions and restricted credential dotfiles', () => {
    const mixedPaths = [
      'bin/malware.exe',
      'scripts/hack.bat',
      '.ssh/id_rsa',
      '.env.production',
      '.git/hooks/pre-commit',
    ]

    const report = auditChangesetPaths(mixedPaths)
    expect(report.isSafe).toBe(false)
    const types = report.violations.map((v) => v.violationType)
    expect(types).toContain('FORBIDDEN_EXTENSION')
    expect(types).toContain('RESTRICTED_DOTFILE')
    expect(report.highestSeverity).toBe('HIGH')
  })
})
