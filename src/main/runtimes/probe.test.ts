import { describe, expect, it } from 'vitest'
import { probeRuntimeExecutable, testRuntimeExecution } from './probe'

describe('probeRuntimeExecutable', () => {
  it('correctly handles null executable as healthy in-process runtime', async () => {
    const result = await probeRuntimeExecutable(null, { isSimulated: false })
    expect(result.available).toBeNull()
    expect(result.version).toBeNull()
    expect(result.health).toBe('healthy')
    expect(result.latencyMs).toBe(0)
  })

  it('correctly handles simulated null executable as simulated', async () => {
    const result = await probeRuntimeExecutable(null, { isSimulated: true })
    expect(result.available).toBeNull()
    expect(result.version).toBeNull()
    expect(result.health).toBe('simulated')
    expect(result.latencyMs).toBe(0)
  })

  it('marks nonexistent command as unavailable', async () => {
    const result = await probeRuntimeExecutable('nonexistent-cli-binary-12345', {
      timeoutMs: 500,
    })
    expect(result.available).toBe(false)
    expect(result.version).toBeNull()
    expect(result.health).toBe('unavailable')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('probes a standard system binary if available', async () => {
    const isWin = process.platform === 'win32'
    const binary = isWin ? 'cmd.exe' : 'node'
    const result = await probeRuntimeExecutable(binary, { timeoutMs: 1500 })
    expect(result.available).toBe(true)
    expect(['healthy', 'degraded']).toContain(result.health)
  })
})

describe('testRuntimeExecution (RUNTIME-002)', () => {
  it('handles in-process native runtime with success', async () => {
    const result = await testRuntimeExecution('forge-native-agent', null)
    expect(result.success).toBe(true)
    expect(result.runtimeId).toBe('forge-native-agent')
    expect(result.executable).toBeNull()
    expect(result.durationMs).toBe(0)
    expect(result.output).toContain('native runtime operational')
  })

  it('handles simulated runtime with success', async () => {
    const result = await testRuntimeExecution('mock-runtime', null, { isSimulated: true })
    expect(result.success).toBe(true)
    expect(result.runtimeId).toBe('mock-runtime')
    expect(result.output).toContain('Simulated runtime execution test passed')
  })

  it('handles nonexistent executable as failure', async () => {
    const result = await testRuntimeExecution('bad-runtime', 'nonexistent-bin-999', {
      timeoutMs: 500,
    })
    expect(result.success).toBe(false)
    expect(result.runtimeId).toBe('bad-runtime')
    expect(result.error).toBeDefined()
  })

  it('executes a valid binary (node) with success', async () => {
    const result = await testRuntimeExecution('node-runtime', process.execPath, {
      timeoutMs: 2000,
    })
    expect(result.success).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.output).toMatch(/v\d+\.\d+/)
  })
})
