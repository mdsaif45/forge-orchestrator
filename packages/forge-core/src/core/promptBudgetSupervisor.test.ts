import { describe, it, expect } from 'vitest'
import {
  auditPromptContextBudget,
  estimateTokens,
  type BudgetSectionInput,
} from './promptBudgetSupervisor'

describe('PromptBudgetSupervisor (AGENT-016)', () => {
  it('estimates tokens proportionally based on characters', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('rejects invalid model max token ceiling', () => {
    expect(() =>
      auditPromptContextBudget({
        modelMaxTokens: 0,
        sections: [],
      }),
    ).toThrow(/positive integer/i)
  })

  it('reports within budget when token count does not exceed available input ceiling', () => {
    const sections: BudgetSectionInput[] = [
      { id: 'system', label: 'System Instructions', priority: 1, content: 'You are Forge.' },
      { id: 'objective', label: 'Task Objective', priority: 2, content: 'Fix bug in auth.' },
    ]

    const report = auditPromptContextBudget({
      modelMaxTokens: 1000,
      outputHeadroomRatio: 0.2, // 200 headroom, 800 available
      sections,
    })

    expect(report.valid).toBe(true)
    expect(report.fitsWithinBudget).toBe(true)
    expect(report.reservedHeadroomTokens).toBe(200)
    expect(report.maxInputBudgetTokens).toBe(800)
    expect(report.overflowTokens).toBe(0)
    expect(report.pruningPlan.every((p) => p.action === 'keep')).toBe(true)
  })

  it('prunes lowest priority sections first upon budget overflow', () => {
    // 100 tokens max, 20 headroom, 80 available
    const sections: BudgetSectionInput[] = [
      { id: 'system', label: 'System Prompt', priority: 1, content: 'A'.repeat(80) }, // 20 tokens
      { id: 'objective', label: 'User Objective', priority: 2, content: 'B'.repeat(80) }, // 20 tokens
      { id: 'files', label: 'Context Files', priority: 4, content: 'C'.repeat(160) }, // 40 tokens
      { id: 'tools', label: 'Tool Output Diffs', priority: 5, content: 'D'.repeat(160) }, // 40 tokens
    ]
    // Total tokens: 20 + 20 + 40 + 40 = 120 tokens. Overflow = 120 - 80 = 40 tokens.

    const report = auditPromptContextBudget({
      modelMaxTokens: 100,
      outputHeadroomRatio: 0.2,
      sections,
    })

    expect(report.fitsWithinBudget).toBe(false)
    expect(report.overflowTokens).toBe(40)

    // Tool outputs (priority 5) should be completely pruned to absorb 40 tokens
    const toolsPlan = report.pruningPlan.find((p) => p.id === 'tools')
    expect(toolsPlan?.action).toBe('prune')
    expect(toolsPlan?.prunedTokens).toBe(40)
    expect(toolsPlan?.remainingTokens).toBe(0)

    // Context files (priority 4) and system/objective should be kept
    const filesPlan = report.pruningPlan.find((p) => p.id === 'files')
    expect(filesPlan?.action).toBe('keep')
    const systemPlan = report.pruningPlan.find((p) => p.id === 'system')
    expect(systemPlan?.action).toBe('keep')
  })

  it('partially truncates sections when overflow is smaller than section size', () => {
    // 100 max, 20 headroom, 80 available.
    const sections: BudgetSectionInput[] = [
      { id: 'system', label: 'System Prompt', priority: 1, content: 'A'.repeat(240) }, // 60 tokens
      { id: 'tools', label: 'Tool Logs', priority: 5, content: 'B'.repeat(160) }, // 40 tokens
    ]
    // Total = 100 tokens. Available = 80 tokens. Overflow = 20 tokens.

    const report = auditPromptContextBudget({
      modelMaxTokens: 100,
      outputHeadroomRatio: 0.2,
      sections,
    })

    expect(report.overflowTokens).toBe(20)
    const toolsPlan = report.pruningPlan.find((p) => p.id === 'tools')
    expect(toolsPlan?.action).toBe('truncate')
    expect(toolsPlan?.prunedTokens).toBe(20)
    expect(toolsPlan?.remainingTokens).toBe(20)
  })
})
