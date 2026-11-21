import { describe, expect, it } from 'vitest'
import { optimizePromptPacket } from './promptOptimizer'

describe('promptOptimizer (AGENT-006)', () => {
  it('identifies static prefixes and computes cacheability metrics accurately', () => {
    const packet = {
      systemPrompt: 'You are Forge, an AI engineering control plane.',
      tools: [{ name: 'readFile', description: 'Read file contents' }],
      contextFiles: ['package.json', 'README.md'],
      objective: 'Implement prompt cache optimizer',
      messages: [
        { role: 'user', content: 'Turn 1' },
        { role: 'assistant', content: 'Response 1' },
      ],
    }

    const report = optimizePromptPacket(packet)
    expect(report.valid).toBe(true)
    expect(report.staticPrefixBytes).toBeGreaterThan(0)
    expect(report.dynamicBytes).toBeGreaterThan(0)
    expect(report.cacheabilityRatio).toBeGreaterThan(0)
    expect(report.cacheabilityRatio).toBeLessThanOrEqual(1)
    expect(report.segments.length).toBe(5)
    expect(report.formattedSummary).toContain('Prompt Context Cache Optimization Report')
  })

  it('handles JSON string inputs', () => {
    const rawJson = JSON.stringify({
      systemPrompt: 'System instructions',
      objective: 'Solve task',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    const report = optimizePromptPacket(rawJson)
    expect(report.valid).toBe(true)
    expect(report.totalBytes).toBeGreaterThan(0)
  })

  it('fails closed on empty or invalid JSON string input (Axiom A2)', () => {
    const emptyReport = optimizePromptPacket('')
    expect(emptyReport.valid).toBe(false)
    expect(emptyReport.error).toBe('Empty prompt packet')

    const invalidReport = optimizePromptPacket('{ invalid json')
    expect(invalidReport.valid).toBe(false)
    expect(invalidReport.error).toBeDefined()
  })

  it('handles custom charsPerToken settings', () => {
    const packet = {
      systemPrompt: '12345678', // 8 chars = 4 tokens @ 2 chars/token
    }

    const report = optimizePromptPacket(packet, { charsPerToken: 2 })
    expect(report.valid).toBe(true)
    expect(report.staticPrefixTokens).toBe(4)
  })
})
