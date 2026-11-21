import { describe, it, expect } from 'vitest'
import { compactPromptContextTurns, type PromptTurn } from './promptCompactor'

describe('Agent Prompt Context Token Budget Compactor (AGENT-013)', () => {
  it('returns empty report when no turns are provided', () => {
    const report = compactPromptContextTurns([])
    expect(report.valid).toBe(true)
    expect(report.originalTurnCount).toBe(0)
    expect(report.compactedTurnCount).toBe(0)
    expect(report.compressedTurnCount).toBe(0)
  })

  it('preserves all turns when total estimated tokens are within budget', () => {
    const turns: PromptTurn[] = [
      { role: 'system', content: 'You are an AI assistant', turnIndex: 0 },
      { role: 'user', content: 'Fix the bug', turnIndex: 1 },
      { role: 'assistant', content: 'Analyzing bug...', turnIndex: 2 },
    ]

    const report = compactPromptContextTurns(turns, { maxTokenBudget: 5000 })
    expect(report.valid).toBe(true)
    expect(report.originalTurnCount).toBe(3)
    expect(report.compactedTurnCount).toBe(3)
    expect(report.compressedTurnCount).toBe(0)
    expect(report.compactedTurns).toEqual(turns)
  })

  it('compacts intermediate turns when budget is exceeded while preserving system prompt and recent turns', () => {
    const turns: PromptTurn[] = [
      { role: 'system', content: 'Base system instructions.', turnIndex: 0 },
      { role: 'user', content: 'x'.repeat(1000), turnIndex: 1 },
      { role: 'assistant', content: 'y'.repeat(1000), toolName: 'file_search', turnIndex: 2 },
      { role: 'tool', content: 'z'.repeat(1000), toolName: 'file_search', turnIndex: 3 },
      { role: 'user', content: 'Recent user turn 1', turnIndex: 4 },
      { role: 'assistant', content: 'Recent assistant turn 2', turnIndex: 5 },
    ]

    const report = compactPromptContextTurns(turns, {
      maxTokenBudget: 500,
      keepRecentTurns: 2,
    })

    expect(report.valid).toBe(true)
    expect(report.originalTurnCount).toBe(6)
    // Pinned system turn (1) + condensed summary turn (1) + 2 recent tail turns = 4
    expect(report.compactedTurnCount).toBe(4)
    expect(report.compressedTurnCount).toBe(3)
    expect(report.compactedEstimatedTokens).toBeLessThan(report.originalEstimatedTokens)
    expect(report.compactedTurns[0]?.role).toBe('system')
    expect(report.compactedTurns[1]?.content).toContain('COMPACTED CONVERSATION HISTORY')
    expect(report.compactedTurns[1]?.content).toContain('file_search')
    expect(report.compactedTurns[2]?.content).toBe('Recent user turn 1')
    expect(report.compactedTurns[3]?.content).toBe('Recent assistant turn 2')
  })

  it('does not compress if remaining candidates are fewer than or equal to keepRecentTurns', () => {
    const turns: PromptTurn[] = [
      { role: 'system', content: 'Long system prompt '.repeat(100), turnIndex: 0 },
      { role: 'user', content: 'Recent user 1', turnIndex: 1 },
      { role: 'assistant', content: 'Recent assistant 2', turnIndex: 2 },
    ]

    const report = compactPromptContextTurns(turns, {
      maxTokenBudget: 10,
      keepRecentTurns: 4,
    })

    expect(report.valid).toBe(true)
    expect(report.compactedTurnCount).toBe(3)
    expect(report.compressedTurnCount).toBe(0)
  })
})
