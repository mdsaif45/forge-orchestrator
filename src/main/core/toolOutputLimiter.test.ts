import { describe, expect, it } from 'vitest'
import { truncateToolOutput } from './toolOutputLimiter'

describe('toolOutputLimiter (AGENT-012)', () => {
  it('passes short outputs through untruncated', () => {
    const text = 'Execution finished with exit code 0.'
    const result = truncateToolOutput(text, { maxBytes: 1024 })
    expect(result.valid).toBe(true)
    expect(result.truncated).toBe(false)
    expect(result.omittedBytes).toBe(0)
    expect(result.output).toBe(text)
  })

  it('bounds long outputs retaining head and tail context (A5)', () => {
    const head = 'START_MARKER: Initializing task environment...'
    const middle = 'x'.repeat(10000)
    const tail = 'END_MARKER: Process terminated cleanly.'
    const full = head + middle + tail

    const result = truncateToolOutput(full, {
      maxBytes: 500,
      headBytes: 100,
      tailBytes: 100,
    })

    expect(result.valid).toBe(true)
    expect(result.truncated).toBe(true)
    expect(result.originalBytes).toBeGreaterThan(10000)
    expect(result.omittedBytes).toBeGreaterThan(9500)
    expect(result.output).toContain(head)
    expect(result.output).toContain(tail)
    expect(result.output).toContain('FORGE STREAM BUFFER CEILING: TRUNCATED')
  })

  it('handles multi-byte utf-8 sequences safely', () => {
    const emojiStr = '🚀'.repeat(2000)
    const result = truncateToolOutput(emojiStr, {
      maxBytes: 256,
      headBytes: 64,
      tailBytes: 64,
    })
    expect(result.valid).toBe(true)
    expect(result.truncated).toBe(true)
    expect(result.output).toContain('🚀')
  })

  it('supports custom omission notice interpolation', () => {
    const input = 'a'.repeat(2000)
    const result = truncateToolOutput(input, {
      maxBytes: 200,
      headBytes: 50,
      tailBytes: 50,
      omissionNotice: '---CUT---',
    })
    expect(result.output).toContain('---CUT---')
    expect(result.omittedBytes).toBe(1900)
  })
})
