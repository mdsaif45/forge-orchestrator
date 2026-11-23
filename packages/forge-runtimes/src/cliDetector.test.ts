import { describe, expect, it } from 'vitest'
import { detectInstalledClis } from './cliDetector'

describe('cliDetector', () => {
  it('probes system for known AI coding CLIs and returns structured results', async () => {
    const detected = await detectInstalledClis()
    expect(Array.isArray(detected)).toBe(true)
    expect(detected.length).toBeGreaterThanOrEqual(5)

    const ids = detected.map((d) => d.id)
    expect(ids).toContain('claude')
    expect(ids).toContain('opencode')
    expect(ids).toContain('codex')
    expect(ids).toContain('agy')
    expect(ids).toContain('aider')

    for (const item of detected) {
      expect(typeof item.id).toBe('string')
      expect(typeof item.name).toBe('string')
      expect(typeof item.executable).toBe('string')
      expect(typeof item.available).toBe('boolean')
    }
  })
})
