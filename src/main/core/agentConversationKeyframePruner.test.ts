import { describe, expect, it } from 'vitest'
import {
  AgentConversationKeyframePruner,
  type KeyframeRole,
} from './agentConversationKeyframePruner'

describe('AgentConversationKeyframePruner', () => {
  it('correctly estimates tokens from text length', () => {
    const pruner = new AgentConversationKeyframePruner({ charactersPerToken: 4 })
    expect(pruner.estimateTokens('1234')).toBe(1)
    expect(pruner.estimateTokens('12345678')).toBe(2)
    expect(pruner.estimateTokens('')).toBe(1) // Math.max(1, ...)
  })

  it('builds keyframe tree with anchors and importance scores', () => {
    const pruner = new AgentConversationKeyframePruner()
    const turns: { role: KeyframeRole; content: string; toolName?: string }[] = [
      { role: 'system', content: 'You are a helpful coding assistant.' },
      { role: 'user', content: 'Implement the feature now.' },
      { role: 'assistant', content: 'Checking codebase files.' },
      { role: 'tool', content: 'src/main.ts\npackage.json', toolName: 'list_dir' },
      { role: 'tool', content: 'function run() { return true }', toolName: 'custom_analysis' },
      { role: 'user', content: 'What did you find?' },
      { role: 'assistant', content: 'I found main.ts and package.json.' },
    ]

    const nodes = pruner.buildKeyframeTree(turns)
    expect(nodes).toHaveLength(7)

    // System prompt anchor
    expect(nodes[0]?.isAnchor).toBe(true)
    expect(nodes[0]?.importanceScore).toBe(100)

    // Initial user prompt anchor
    expect(nodes[1]?.isAnchor).toBe(true)
    expect(nodes[1]?.importanceScore).toBe(90)

    // Ephemeral tool vs non-ephemeral tool
    expect(nodes[3]?.toolName).toBe('list_dir')
    expect(nodes[3]?.importanceScore).toBe(15) // ephemeral
    expect(nodes[4]?.toolName).toBe('custom_analysis')
    expect(nodes[4]?.importanceScore).toBe(35) // non-ephemeral

    // Recent working context turns (last 2)
    expect(nodes[5]?.importanceScore).toBeGreaterThanOrEqual(80)
    expect(nodes[6]?.importanceScore).toBeGreaterThanOrEqual(80)
  })

  it('returns untouched plan when tokens are within budget', () => {
    const pruner = new AgentConversationKeyframePruner({ maxContextTokens: 1000 })
    const turns = [
      { role: 'system' as const, content: 'Sys' },
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there' },
    ]

    const plan = pruner.prune(turns)
    expect(plan.originalTurnCount).toBe(3)
    expect(plan.retainedTurnCount).toBe(3)
    expect(plan.prunedTurnCount).toBe(0)
    expect(plan.tokenReductionPercentage).toBe(0)
    expect(plan.turns).toHaveLength(3)
  })

  it('truncates large ephemeral tool outputs during phase 1 compression', () => {
    const pruner = new AgentConversationKeyframePruner({
      maxContextTokens: 50,
      charactersPerToken: 4,
    })
    const largeToolOutput = 'A'.repeat(800) // 200 tokens
    const turns = [
      { role: 'system' as const, content: 'System instruction' },
      { role: 'user' as const, content: 'Run tool' },
      { role: 'tool' as const, content: largeToolOutput, toolName: 'search_files' },
      { role: 'assistant' as const, content: 'Done' },
    ]

    const plan = pruner.prune(turns)
    expect(plan.prunedTokensEst).toBeLessThan(plan.originalTokensEst)
    const toolNode = plan.turns.find((t) => t.role === 'tool')
    expect(toolNode).toBeDefined()
    expect(toolNode?.content).toContain('[Truncated observation: output exceeded token budget')
  })

  it('discards lowest importance turns during phase 2 when budget is still exceeded', () => {
    const pruner = new AgentConversationKeyframePruner({
      maxContextTokens: 30,
      charactersPerToken: 4,
    })
    const turns = [
      { role: 'system' as const, content: 'Permanent system prompt anchor.' },
      { role: 'user' as const, content: 'Permanent primary objective anchor.' },
      {
        role: 'tool' as const,
        content: 'Intermediate directory scan result.',
        toolName: 'list_dir',
      },
      { role: 'assistant' as const, content: ' intermediate thought.' },
      { role: 'tool' as const, content: 'Intermediate file read.', toolName: 'read_file' },
      { role: 'user' as const, content: 'Latest query.' },
      { role: 'assistant' as const, content: 'Final response.' },
    ]

    const plan = pruner.prune(turns)
    expect(plan.prunedTurnCount).toBeGreaterThan(0)
    expect(plan.turns.length).toBeLessThan(turns.length)

    // Anchors must be retained
    const systemTurn = plan.turns.find((t) => t.role === 'system')
    expect(systemTurn).toBeDefined()
    expect(systemTurn?.content).toBe('Permanent system prompt anchor.')

    const primaryUserTurn = plan.turns.find(
      (t) => t.role === 'user' && t.content === 'Permanent primary objective anchor.',
    )
    expect(primaryUserTurn).toBeDefined()
  })

  it('handles empty turn input gracefully', () => {
    const pruner = new AgentConversationKeyframePruner()
    const plan = pruner.prune([])
    expect(plan.originalTurnCount).toBe(0)
    expect(plan.retainedTurnCount).toBe(0)
    expect(plan.tokenReductionPercentage).toBe(0)
    expect(plan.turns).toHaveLength(0)
  })
})
