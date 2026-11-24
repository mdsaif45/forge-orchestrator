/**
 * AGENT-017: Agent conversation checkpoint summarizer and context rolling window compressor.
 * Condenses older turns into structured milestone recaps while preserving recent turns intact (Axioms A1, A5).
 */

export interface ConversationTurn {
  readonly role: 'user' | 'assistant' | 'system' | 'tool'
  readonly content: string
  readonly toolCallId?: string | undefined
  readonly name?: string | undefined
  readonly timestamp?: string | undefined
}

export interface MilestoneRecap {
  readonly goalsAchieved: string[]
  readonly filesModified: string[]
  readonly decisionsLocked: string[]
  readonly pendingHypotheses: string[]
}

export interface CompressorOptions {
  readonly maxTokens?: number | undefined
  readonly rollingWindowTurns?: number | undefined
  readonly preserveSystemPrompt?: boolean | undefined
}

export interface CompressionResult {
  readonly originalTurns: number
  readonly compressedTurns: number
  readonly originalTokenEstimate: number
  readonly compressedTokenEstimate: number
  readonly summary: string
  readonly turns: ConversationTurn[]
}

/**
 * Heuristic token estimation: ~4 chars per token.
 */
export function estimateTurnTokens(turn: ConversationTurn): number {
  const contentTokens = Math.ceil(turn.content.length / 4)
  const overhead = 4 // per-message structural token overhead
  return contentTokens + overhead
}

/**
 * Synthesizes a structured milestone recap from a sequence of conversation turns.
 */
export function synthesizeMilestoneSummary(turns: readonly ConversationTurn[]): MilestoneRecap {
  const goalsAchieved: string[] = []
  const filesModified = new Set<string>()
  const decisionsLocked: string[] = []
  const pendingHypotheses: string[] = []

  const fileRegex = /([a-zA-Z0-9_\-./\\]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|sql|css|html))/g

  for (const turn of turns) {
    const text = turn.content

    // File mutation / inspection extraction
    const matches = text.match(fileRegex)
    if (matches) {
      for (const m of matches) {
        if (!m.startsWith('http') && !m.includes('node_modules')) {
          filesModified.add(m)
        }
      }
    }

    // Milestone & decision keywords
    const lines = text.split('\n')
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (/^(decision|locked|agreed):/i.test(line)) {
        decisionsLocked.push(line.replace(/^(decision|locked|agreed):\s*/i, ''))
      } else if (/^(goal|achieved|delivered|completed):/i.test(line)) {
        goalsAchieved.push(line.replace(/^(goal|achieved|delivered|completed):\s*/i, ''))
      } else if (/^(hypothesis|next|todo|pending):/i.test(line)) {
        pendingHypotheses.push(line.replace(/^(hypothesis|next|todo|pending):\s*/i, ''))
      }
    }
  }

  return {
    goalsAchieved,
    filesModified: Array.from(filesModified),
    decisionsLocked,
    pendingHypotheses,
  }
}

/**
 * Compresses conversation history when total tokens or turn counts exceed bounds.
 */
export function compressConversationHistory(
  turns: readonly ConversationTurn[],
  options: CompressorOptions = {},
): CompressionResult {
  const rollingWindowTurns = Math.max(1, options.rollingWindowTurns ?? 4)
  const maxTokens = options.maxTokens ?? 8192
  const preserveSystemPrompt = options.preserveSystemPrompt ?? true

  const originalTurnsCount = turns.length
  let originalTokenSum = 0
  for (const t of turns) {
    originalTokenSum += estimateTurnTokens(t)
  }

  // If already under budget and turn count is manageable, return unchanged
  if (originalTurnsCount <= rollingWindowTurns + 1 && originalTokenSum <= maxTokens) {
    return {
      originalTurns: originalTurnsCount,
      compressedTurns: originalTurnsCount,
      originalTokenEstimate: originalTokenSum,
      compressedTokenEstimate: originalTokenSum,
      summary: 'No compression required; transcript is within token and turn budgets.',
      turns: [...turns],
    }
  }

  // Separate leading system turn if present and preserved
  let leadingSystemTurn: ConversationTurn | undefined
  let workingTurns = [...turns]

  if (preserveSystemPrompt && workingTurns[0]?.role === 'system') {
    leadingSystemTurn = workingTurns[0]
    workingTurns = workingTurns.slice(1)
  }

  // If working turns are fewer than or equal to window size, no compression of tail
  if (workingTurns.length <= rollingWindowTurns) {
    const finalTurns = leadingSystemTurn ? [leadingSystemTurn, ...workingTurns] : workingTurns
    let finalTokens = 0
    for (const t of finalTurns) {
      finalTokens += estimateTurnTokens(t)
    }

    return {
      originalTurns: originalTurnsCount,
      compressedTurns: finalTurns.length,
      originalTokenEstimate: originalTokenSum,
      compressedTokenEstimate: finalTokens,
      summary: 'Tail turns within window; preserved intact.',
      turns: finalTurns,
    }
  }

  // Partition turns into older (to summarize) and recent tail (to keep verbatim)
  const olderTurns = workingTurns.slice(0, workingTurns.length - rollingWindowTurns)
  const recentTurns = workingTurns.slice(workingTurns.length - rollingWindowTurns)

  const recap = synthesizeMilestoneSummary(olderTurns)

  const recapLines: string[] = [
    `[CONVERSATION MILESTONE RECAP — Condensed ${String(olderTurns.length)} older turns]`,
  ]

  if (recap.goalsAchieved.length > 0) {
    recapLines.push('Goals Achieved:')
    for (const g of recap.goalsAchieved) {
      recapLines.push(`- ${g}`)
    }
  }

  if (recap.decisionsLocked.length > 0) {
    recapLines.push('Decisions Locked:')
    for (const d of recap.decisionsLocked) {
      recapLines.push(`- ${d}`)
    }
  }

  if (recap.filesModified.length > 0) {
    recapLines.push(`Files Referenced/Mutated: ${recap.filesModified.join(', ')}`)
  }

  if (recap.pendingHypotheses.length > 0) {
    recapLines.push('Active Hypotheses / Next Tasks:')
    for (const h of recap.pendingHypotheses) {
      recapLines.push(`- ${h}`)
    }
  }

  if (
    recap.goalsAchieved.length === 0 &&
    recap.decisionsLocked.length === 0 &&
    recap.filesModified.length === 0 &&
    recap.pendingHypotheses.length === 0
  ) {
    recapLines.push(
      `Summarized ${String(olderTurns.length)} conversational turns with no explicitly tagged decisions or mutations.`,
    )
  }

  const recapTurn: ConversationTurn = {
    role: 'system',
    content: recapLines.join('\n'),
    timestamp: new Date().toISOString(),
  }

  const resultTurns: ConversationTurn[] = []
  if (leadingSystemTurn) {
    resultTurns.push(leadingSystemTurn)
  }
  resultTurns.push(recapTurn)
  for (const t of recentTurns) {
    resultTurns.push(t)
  }

  let compressedTokenSum = 0
  for (const t of resultTurns) {
    compressedTokenSum += estimateTurnTokens(t)
  }

  const summary = `Compressed ${String(originalTurnsCount)} turns down to ${String(resultTurns.length)} turns (saved ~${String(originalTokenSum - compressedTokenSum)} tokens).`

  return {
    originalTurns: originalTurnsCount,
    compressedTurns: resultTurns.length,
    originalTokenEstimate: originalTokenSum,
    compressedTokenEstimate: compressedTokenSum,
    summary,
    turns: resultTurns,
  }
}
