import { describe, expect, it } from 'vitest'
import { WorkspaceDependencyAuditGate, type SecurityAdvisory } from './workspaceDependencyAuditGate'

describe('WorkspaceDependencyAuditGate', () => {
  it('correctly compares semantic versions', () => {
    const gate = new WorkspaceDependencyAuditGate()
    expect(gate.compareSemVer('1.2.3', '1.2.4')).toBe(-1)
    expect(gate.compareSemVer('2.0.0', '1.9.9')).toBe(1)
    expect(gate.compareSemVer('1.5.0', '1.5.0')).toBe(0)
    expect(gate.compareSemVer('v1.0.0', '1.0.0')).toBe(0)
  })

  it('evaluates version range constraints accurately', () => {
    const gate = new WorkspaceDependencyAuditGate()
    expect(gate.satisfiesRange('4.17.15', '<4.17.21')).toBe(true)
    expect(gate.satisfiesRange('4.17.21', '<4.17.21')).toBe(false)
    expect(gate.satisfiesRange('7.0.3', '>=7.0.0 <7.0.5')).toBe(true)
    expect(gate.satisfiesRange('7.0.5', '>=7.0.0 <7.0.5')).toBe(false)
  })

  it('parses dependencies from package.json manifest string', () => {
    const gate = new WorkspaceDependencyAuditGate()
    const pkgJson = JSON.stringify({
      dependencies: {
        lodash: '^4.17.19',
        express: '4.18.2',
      },
      devDependencies: {
        vitest: '~1.0.0',
      },
    })

    const parsed = gate.parseDependencies(pkgJson)
    expect(parsed.get('lodash')).toBe('4.17.19')
    expect(parsed.get('express')).toBe('4.18.2')
    expect(parsed.get('vitest')).toBe('1.0.0')
  })

  it('parses dependencies from package-lock.json v2/v3 packages format', () => {
    const gate = new WorkspaceDependencyAuditGate()
    const lockJson = JSON.stringify({
      packages: {
        '': { name: 'app', version: '1.0.0' },
        'node_modules/tar': { version: '6.1.0' },
        'node_modules/ws': { version: '8.16.0' },
      },
    })

    const parsed = gate.parseDependencies(lockJson)
    expect(parsed.get('tar')).toBe('6.1.0')
    expect(parsed.get('ws')).toBe('8.16.0')
  })

  it('blocks audit gate when critical vulnerability is detected', () => {
    const gate = new WorkspaceDependencyAuditGate({ blockThresholdSeverity: 'HIGH' })
    const report = gate.audit({
      tar: '6.1.0', // vulnerable to FORGE-ADV-2024-002 (CRITICAL)
    })

    expect(report.scannedPackagesCount).toBe(1)
    expect(report.vulnerabilitiesCount).toBe(1)
    expect(report.highestSeverity).toBe('CRITICAL')
    expect(report.gateApproved).toBe(false)
    expect(report.summary).toContain('Audit BLOCKED')
    expect(report.matches[0]?.advisory.cve).toBe('CVE-2024-28863')
  })

  it('approves audit gate when vulnerability severity is below block threshold', () => {
    const gate = new WorkspaceDependencyAuditGate({ blockThresholdSeverity: 'HIGH' })
    const report = gate.audit({
      axios: '1.6.0', // vulnerable to FORGE-ADV-2024-005 (MODERATE)
    })

    expect(report.scannedPackagesCount).toBe(1)
    expect(report.vulnerabilitiesCount).toBe(1)
    expect(report.highestSeverity).toBe('MODERATE')
    expect(report.gateApproved).toBe(true) // MODERATE < HIGH
    expect(report.summary).toContain('Audit PASSED')
  })

  it('approves audit gate when no packages are vulnerable', () => {
    const gate = new WorkspaceDependencyAuditGate()
    const report = gate.audit({
      lodash: '4.17.21',
      tar: '6.2.1',
      axios: '1.7.4',
    })

    expect(report.vulnerabilitiesCount).toBe(0)
    expect(report.gateApproved).toBe(true)
    expect(report.summary).toContain('Audit PASSED')
  })

  it('supports registering custom security advisories', () => {
    const gate = new WorkspaceDependencyAuditGate()
    const customAdv: SecurityAdvisory = {
      advisoryId: 'CUSTOM-001',
      packageName: 'my-internal-lib',
      vulnerableRange: '<2.0.0',
      severity: 'CRITICAL',
      title: 'Remote code execution in internal lib',
    }

    gate.registerAdvisory(customAdv)
    const report = gate.audit({ 'my-internal-lib': '1.5.2' })

    expect(report.gateApproved).toBe(false)
    expect(report.matches[0]?.advisory.advisoryId).toBe('CUSTOM-001')
  })
})
