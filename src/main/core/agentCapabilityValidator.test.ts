import { describe, expect, it } from 'vitest'
import { AgentCapabilityValidator, type ToolCapabilityDescriptor } from './agentCapabilityValidator'

describe('AgentCapabilityValidator', () => {
  it('validates a descriptor when all environment prerequisites are satisfied', () => {
    const validator = new AgentCapabilityValidator({
      currentPlatform: 'win32',
      activePermissionMode: 'acceptEdits',
      isOffline: false,
      availableBinaries: ['git', 'node', 'npm'],
    })

    const descriptor: ToolCapabilityDescriptor = {
      id: 'git-commit',
      name: 'Git Commit Tool',
      requiredBinaries: ['git'],
      supportedPlatforms: ['win32', 'linux', 'darwin'],
      minimumPermissionMode: 'acceptEdits',
      networkRequired: false,
    }

    const report = validator.validate(descriptor)
    expect(report.isReady).toBe(true)
    expect(report.missingBinaries).toEqual([])
    expect(report.platformSupported).toBe(true)
    expect(report.permissionSatisfied).toBe(true)
    expect(report.networkSatisfied).toBe(true)
    expect(report.diagnostics).toHaveLength(0)
    expect(report.remediationHints).toHaveLength(0)
  })

  it('fails validation when required binaries are missing', () => {
    const validator = new AgentCapabilityValidator({
      currentPlatform: 'linux',
      activePermissionMode: 'bypassPermissions',
      isOffline: false,
      availableBinaries: ['git'],
    })

    const descriptor: ToolCapabilityDescriptor = {
      id: 'docker-build',
      name: 'Docker Build Runner',
      requiredBinaries: ['docker', 'docker-compose'],
      minimumPermissionMode: 'acceptEdits',
    }

    const report = validator.validate(descriptor)
    expect(report.isReady).toBe(false)
    expect(report.missingBinaries).toEqual(['docker', 'docker-compose'])
    expect(report.diagnostics[0]).toContain('Missing required executable binaries')
    expect(report.remediationHints[0]).toContain('Ensure the following binaries are installed')
  })

  it('fails validation when platform is unsupported', () => {
    const validator = new AgentCapabilityValidator({
      currentPlatform: 'darwin',
      activePermissionMode: 'acceptEdits',
      availableBinaries: ['powershell'],
    })

    const descriptor: ToolCapabilityDescriptor = {
      id: 'powershell-runner',
      name: 'PowerShell Win32 Runner',
      supportedPlatforms: ['win32'],
    }

    const report = validator.validate(descriptor)
    expect(report.isReady).toBe(false)
    expect(report.platformSupported).toBe(false)
    expect(report.diagnostics[0]).toContain('Platform "darwin" is not supported')
  })

  it('fails validation when active permission mode is below required minimum rank', () => {
    const validator = new AgentCapabilityValidator({
      currentPlatform: 'linux',
      activePermissionMode: 'plan',
      availableBinaries: ['bash'],
    })

    const descriptor: ToolCapabilityDescriptor = {
      id: 'bash-executor',
      name: 'Bash Execution Tool',
      minimumPermissionMode: 'acceptEdits',
    }

    const report = validator.validate(descriptor)
    expect(report.isReady).toBe(false)
    expect(report.permissionSatisfied).toBe(false)
    expect(report.diagnostics[0]).toContain('Active permission mode "plan" is insufficient')
  })

  it('fails validation when network is required but environment is offline', () => {
    const validator = new AgentCapabilityValidator({
      currentPlatform: 'linux',
      activePermissionMode: 'bypassPermissions',
      isOffline: true,
      availableBinaries: ['curl'],
    })

    const descriptor: ToolCapabilityDescriptor = {
      id: 'web-fetcher',
      name: 'External Web Client',
      requiredBinaries: ['curl'],
      networkRequired: true,
    }

    const report = validator.validate(descriptor)
    expect(report.isReady).toBe(false)
    expect(report.networkSatisfied).toBe(false)
    expect(report.diagnostics[0]).toContain(
      'requires external network access, but environment is configured as offline',
    )
  })
})
