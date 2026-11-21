/**
 * AGENT-016: Agent prompt context window budgeting and automatic truncation estimator.
 * Bounded context window allocation and output headroom reservation (Axioms A1, A5).
 */

export interface BudgetSectionInput {
  readonly id: string
  readonly label: string
  readonly priority: number // 1 (highest, keep last) to 5 (lowest, prune first)
  readonly content: string
}

export interface BudgetSectionAudit {
  readonly id: string
  readonly label: string
  readonly priority: number
  readonly characters: number
  readonly estimatedTokens: number
  readonly prunable: boolean
}

export interface TruncatedSectionPlan {
  readonly id: string
  readonly label: string
  readonly originalTokens: number
  readonly prunedTokens: number
  readonly remainingTokens: number
  readonly action: 'keep' | 'prune' | 'truncate'
}

export interface ContextBudgetReport {
  readonly valid: boolean
  readonly modelMaxTokens: number
  readonly reservedHeadroomTokens: number
  readonly maxInputBudgetTokens: number
  readonly totalEstimatedInputTokens: number
  readonly fitsWithinBudget: boolean
  readonly overflowTokens: number
  readonly sections: readonly BudgetSectionAudit[]
  readonly pruningPlan: readonly TruncatedSectionPlan[]
  readonly formattedSummary: string
}

export interface ContextBudgetOptions {
  readonly modelMaxTokens: number
  readonly outputHeadroomRatio?: number | undefined // default 0.20 (20%)
  readonly charactersPerToken?: number | undefined // default 4
  readonly sections: readonly BudgetSectionInput[]
}

/**
 * Estimates token count from raw text string.
 */
export function estimateTokens(text: string, charactersPerToken = 4): number {
  if (!text || text.length === 0) return 0
  return Math.ceil(text.length / charactersPerToken)
}

/**
 * Audits context token consumption against model limits and produces a prioritized truncation plan.
 */
export function auditPromptContextBudget(options: ContextBudgetOptions): ContextBudgetReport {
  const modelMaxTokens = options.modelMaxTokens
  if (modelMaxTokens <= 0) {
    throw new Error(
      `Invalid modelMaxTokens: ${String(modelMaxTokens)}. Must be a positive integer.`,
    )
  }

  const headroomRatio = Math.max(0, Math.min(0.8, options.outputHeadroomRatio ?? 0.2))
  const charactersPerToken = options.charactersPerToken ?? 4

  const reservedHeadroomTokens = Math.round(modelMaxTokens * headroomRatio)
  const maxInputBudgetTokens = modelMaxTokens - reservedHeadroomTokens

  const sectionAudits: BudgetSectionAudit[] = options.sections.map((s) => {
    const tokens = estimateTokens(s.content, charactersPerToken)
    return {
      id: s.id,
      label: s.label,
      priority: s.priority,
      characters: s.content.length,
      estimatedTokens: tokens,
      prunable: s.priority > 1,
    }
  })

  const totalEstimatedInputTokens = sectionAudits.reduce((acc, s) => acc + s.estimatedTokens, 0)
  const fitsWithinBudget = totalEstimatedInputTokens <= maxInputBudgetTokens
  const overflowTokens = fitsWithinBudget ? 0 : totalEstimatedInputTokens - maxInputBudgetTokens

  // Compute pruning plan by pruning lowest priority (highest number) first
  let tokensToPruneRemaining = overflowTokens
  const pruningPlan: TruncatedSectionPlan[] = []

  // Sort sections by priority descending (5 down to 1) for pruning order
  const sortedByPruneOrder = [...sectionAudits].sort((a, b) => b.priority - a.priority)
  const pruneMap = new Map<
    string,
    { pruned: number; remaining: number; action: 'keep' | 'prune' | 'truncate' }
  >()

  for (const s of sortedByPruneOrder) {
    if (tokensToPruneRemaining <= 0 || !s.prunable) {
      pruneMap.set(s.id, {
        pruned: 0,
        remaining: s.estimatedTokens,
        action: 'keep',
      })
      continue
    }

    if (s.estimatedTokens <= tokensToPruneRemaining) {
      // Entire section pruned
      pruneMap.set(s.id, {
        pruned: s.estimatedTokens,
        remaining: 0,
        action: 'prune',
      })
      tokensToPruneRemaining -= s.estimatedTokens
    } else {
      // Partially truncated
      const pruned = tokensToPruneRemaining
      const remaining = s.estimatedTokens - pruned
      pruneMap.set(s.id, {
        pruned,
        remaining,
        action: 'truncate',
      })
      tokensToPruneRemaining = 0
    }
  }

  // Restore original section ordering
  for (const s of sectionAudits) {
    const plan = pruneMap.get(s.id) ?? { pruned: 0, remaining: s.estimatedTokens, action: 'keep' }
    pruningPlan.push({
      id: s.id,
      label: s.label,
      originalTokens: s.estimatedTokens,
      prunedTokens: plan.pruned,
      remainingTokens: plan.remaining,
      action: plan.action,
    })
  }

  const valid = tokensToPruneRemaining === 0 // All overflow successfully resolved

  const lines: string[] = [
    `PROMPT CONTEXT BUDGET REPORT:`,
    `  Model Context Ceiling:      ${String(modelMaxTokens)} tokens`,
    `  Reserved Output Headroom:   ${String(reservedHeadroomTokens)} tokens (${String(Math.round(headroomRatio * 100))}%)`,
    `  Available Input Budget:     ${String(maxInputBudgetTokens)} tokens`,
    `  Total Estimated Input:      ${String(totalEstimatedInputTokens)} tokens`,
    `  Status:                     ${fitsWithinBudget ? 'FITS WITHIN BUDGET' : 'OVERFLOW DETECTED'}`,
  ]

  if (!fitsWithinBudget) {
    lines.push(`  Overflow Amount:            ${String(overflowTokens)} tokens`)
    lines.push(`  Pruning Strategy:`)
    for (const p of pruningPlan) {
      if (p.action !== 'keep') {
        lines.push(
          `    • ${p.label} [${p.id}]: ${p.action.toUpperCase()} (-${String(p.prunedTokens)} tokens, ${String(p.remainingTokens)} remaining)`,
        )
      }
    }
  }

  return {
    valid,
    modelMaxTokens,
    reservedHeadroomTokens,
    maxInputBudgetTokens,
    totalEstimatedInputTokens,
    fitsWithinBudget,
    overflowTokens,
    sections: sectionAudits,
    pruningPlan,
    formattedSummary: lines.join('\n'),
  }
}
