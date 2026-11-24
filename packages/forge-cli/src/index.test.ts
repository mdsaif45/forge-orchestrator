import { describe, expect, it, vi } from 'vitest'
import { runCli } from './index'

describe('@forge/cli package contracts', () => {
  it('prints version and returns exit code 0', async () => {
    const code = await runCli(['--version'])
    expect(code).toBe(0)
  })

  it('prints help text and returns exit code 0', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const code = await runCli(['--help'])
    expect(code).toBe(0)
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Forge'))
    consoleLog.mockRestore()
  })

  it('returns exit code 1 on unknown subcommand', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await runCli(['non-existent-subcommand-12345'])
    expect(code).toBe(1)
    consoleError.mockRestore()
  })
})
