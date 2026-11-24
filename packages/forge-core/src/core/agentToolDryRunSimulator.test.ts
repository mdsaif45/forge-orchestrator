import { describe, expect, it } from 'vitest'
import { AgentToolDryRunSimulator, type PlannedToolInvocation } from './agentToolDryRunSimulator'

describe('AgentToolDryRunSimulator', () => {
  it('allows read-only operations with 0 blast radius score', () => {
    const simulator = new AgentToolDryRunSimulator()
    const invocation: PlannedToolInvocation = {
      toolName: 'read_file',
      parameters: { path: 'src/main/cli.ts' },
    }

    const report = simulator.simulate(invocation)
    expect(report.isAllowed).toBe(true)
    expect(report.severity).toBe('READ_ONLY')
    expect(report.blastRadiusScore).toBe(0)
    expect(report.predictedChanges).toHaveLength(0)
    expect(report.diagnostics).toHaveLength(0)
  })

  it('allows safe workspace file mutations within boundaries', () => {
    const simulator = new AgentToolDryRunSimulator()
    const invocation: PlannedToolInvocation = {
      toolName: 'write_file',
      parameters: { path: 'src/feature.ts', content: 'export const a = 1;' },
    }

    const report = simulator.simulate(invocation)
    expect(report.isAllowed).toBe(true)
    expect(report.severity).toBe('WORKSPACE_MUTATION')
    expect(report.blastRadiusScore).toBe(1)
    expect(report.predictedChanges[0]).toMatch(/src[\\/]feature\.ts/)
  })

  it('blocks tool execution that attempts path traversal outside workspace', () => {
    const simulator = new AgentToolDryRunSimulator()
    const invocation: PlannedToolInvocation = {
      toolName: 'write_file',
      parameters: { path: '../../etc/passwd' },
    }

    const report = simulator.simulate(invocation)
    expect(report.isAllowed).toBe(false)
    expect(report.diagnostics[0]).toContain('traverses outside workspace boundary')
    expect(report.remediationHints[0]).toContain('Confine tool operations strictly')
  })

  it('blocks tool execution attempting to modify protected directories (.git, .kilo, .vscode)', () => {
    const simulator = new AgentToolDryRunSimulator()
    const invocation: PlannedToolInvocation = {
      toolName: 'write_file',
      parameters: { path: '.git/config' },
    }

    const report = simulator.simulate(invocation)
    expect(report.isAllowed).toBe(false)
    expect(report.diagnostics[0]).toContain('touches protected directory ".git"')
  })

  it('classifies destructive operations and blocks when blast radius exceeds ceiling', () => {
    const simulator = new AgentToolDryRunSimulator({ maxAllowedBlastRadius: 10 })
    const invocation: PlannedToolInvocation = {
      toolName: 'file_delete',
      parameters: {},
      targetPaths: ['file1.ts', 'file2.ts', 'file3.ts', 'file4.ts', 'file5.ts'],
    }

    const report = simulator.simulate(invocation)
    expect(report.severity).toBe('DESTRUCTIVE')
    expect(report.blastRadiusScore).toBe(15) // 5 * 3 = 15 > 10
    expect(report.isAllowed).toBe(false)
    expect(report.diagnostics[0]).toContain('exceeds allowed ceiling')
  })
})
