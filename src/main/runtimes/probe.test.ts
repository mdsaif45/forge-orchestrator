import { describe, expect, it } from 'vitest'
import { probeRuntimeExecutable } from './probe'

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
