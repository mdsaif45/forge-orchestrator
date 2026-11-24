import { describe, it, expect } from 'vitest'
import {
  compressConversationHistory,
  synthesizeMilestoneSummary,
  estimateTurnTokens,
  type ConversationTurn,
} from './conversationCompressor'

describe('ConversationCompressor (AGENT-017)', () => {
  it('estimates token counts with expected character ratios and message overhead', () => {
    const turn: ConversationTurn = {
      role: 'user',
      content: 'Hello Forge Agent!',
    }
    const tokens = estimateTurnTokens(turn)
    // 18 chars / 4 = 4.5 -> 5 + 4 = 9 tokens
    expect(tokens).toBe(9)
  })

  it('synthesizes milestone recaps from structured turn text', () => {
    const turns: ConversationTurn[] = [
      {
        role: 'user',
        content: 'Goal: Implement prompt compression\nDecision: Lock sliding window to 4 turns',
      },
      {
        role: 'assistant',
        content:
          'I edited src/main/core/compressor.ts and tests in src/main/core/compressor.test.ts',
      },
      {
        role: 'user',
        content: 'Next: Verify with unit tests',
      },
    ]

    const recap = synthesizeMilestoneSummary(turns)
    expect(recap.goalsAchieved).toContain('Implement prompt compression')
    expect(recap.decisionsLocked).toContain('Lock sliding window to 4 turns')
    expect(recap.filesModified).toContain('src/main/core/compressor.ts')
    expect(recap.filesModified).toContain('src/main/core/compressor.test.ts')
    expect(recap.pendingHypotheses).toContain('Verify with unit tests')
  })

  it('preserves transcripts when within budget and window', () => {
    const turns: ConversationTurn[] = [
      { role: 'system', content: 'You are Forge Agent.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
    ]

    const res = compressConversationHistory(turns, {
      rollingWindowTurns: 4,
      maxTokens: 1000,
    })

    expect(res.compressedTurns).toBe(3)
    expect(res.turns).toEqual(turns)
    expect(res.summary).toContain('within token and turn budgets')
  })

  it('compresses older turns and preserves rolling recent tail and system prompt', () => {
    const turns: ConversationTurn[] = [
      { role: 'system', content: 'You are Forge Agent.' },
      {
        role: 'user',
        content:
          'Goal: Refactor database schema for scalability\nDecision: Use SQLite WAL mode\nWe need to ensure that the entire persistence layer is properly optimized for multi-process environments, with proper error handling and retry loops.',
      },
      {
        role: 'assistant',
        content:
          'I have modified src/main/db/schema.ts for WAL mode. In addition, I created multiple migration scripts and verified that foreign key constraints and index lookups operate within acceptable performance bounds across all test benches.',
      },
      {
        role: 'user',
        content:
          'Hypothesis: Check if WAL causes write lock contention under load\nLet us run stress tests against the SQLite database to verify lock timeouts.',
      },
      {
        role: 'assistant',
        content:
          'Stress tests ran successfully. Lock timeout configured to 5000ms. No lock contention detected during 1000 simulated parallel queries.',
      },
      { role: 'user', content: 'Turn 5 recent' },
      { role: 'assistant', content: 'Turn 6 recent response' },
    ]

    const res = compressConversationHistory(turns, {
      rollingWindowTurns: 2,
      maxTokens: 50,
      preserveSystemPrompt: true,
    })

    // System prompt + 1 recap turn + 2 recent turns = 4 turns
    expect(res.compressedTurns).toBe(4)
    expect(res.turns[0]?.role).toBe('system')
    expect(res.turns[0]?.content).toBe('You are Forge Agent.')
    expect(res.turns[1]?.role).toBe('system')
    expect(res.turns[1]?.content).toContain('[CONVERSATION MILESTONE RECAP')
    expect(res.turns[1]?.content).toContain('Refactor database schema')
    expect(res.turns[1]?.content).toContain('Use SQLite WAL mode')
    expect(res.turns[1]?.content).toContain('src/main/db/schema.ts')
    expect(res.turns[2]?.content).toBe('Turn 5 recent')
    expect(res.turns[3]?.content).toBe('Turn 6 recent response')
    expect(res.compressedTokenEstimate).toBeLessThan(res.originalTokenEstimate)
  })

  it('handles generic older turns without structured tags gracefully', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'How are you?' },
      { role: 'assistant', content: 'I am doing well.' },
      { role: 'user', content: 'What is the weather?' },
      { role: 'assistant', content: 'It is sunny.' },
      { role: 'user', content: 'Recent turn' },
    ]

    const res = compressConversationHistory(turns, {
      rollingWindowTurns: 1,
      maxTokens: 20,
    })

    expect(res.compressedTurns).toBe(2) // 1 recap + 1 recent
    expect(res.turns[0]?.content).toContain('Summarized 4 conversational turns')
  })
})
