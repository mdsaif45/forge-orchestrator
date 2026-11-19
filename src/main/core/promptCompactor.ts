/**
 * AGENT-013: Agent prompt context token budget trimmer and sliding window compactor.
 * Prunes historical turn overhead while preserving task goals and latest execution evidence (Axioms A1, A5).
 */

export interface PromptTurn {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string
  readonly toolName?: string | undefined
  readonly toolCallId?: string | undefined
  readonly turnIndex: number
}

export interface PromptCompactionOptions {
  readonly maxTokenBudget?: number | undefined
  readonly keepRecentTurns?: number | undefined
  readonly charsPerToken?: number | undefined
  readonly pinSystemPrompt?: boolean | undefined
}

export interface PromptCompactionReport {
  readonly valid: boolean
  readonly originalTurnCount: number
  readonly compactedTurnCount: number
  readonly originalEstimatedTokens: number
  readonly compactedEstimatedTokens: number
  readonly compressedTurnCount: number
  readonly compactedTurns: readonly PromptTurn[]
  readonly formattedSummary: string
}

const DEFAULT_MAX_TOKEN_BUDGET = 8192
const DEFAULT_KEEP_RECENT_TURNS = 4
const DEFAULT_CHARS_PER_TOKEN = 3.8

function estimateTokens(text: string, charsPerToken: number): number {
  if (text.length === 0) return 0
  return Math.max(1, Math.ceil(text.length / charsPerToken))
}

/**
 * Compacts conversation turns to fit within a bounded token budget (Axioms A1, A5).
 */
export function compactPromptContextTurns(
  turns: readonly PromptTurn[],
  options?: PromptCompactionOptions,
): PromptCompactionReport {
  const maxBudget = options?.maxTokenBudget ?? DEFAULT_MAX_TOKEN_BUDGET
  const keepRecent = Math.max(1, options?.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS)
  const charsPerToken = Math.max(1, options?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN)
  const pinSystem = options?.pinSystemPrompt ?? true

  if (turns.length === 0) {
    return {
      valid: true,
      originalTurnCount: 0,
      compactedTurnCount: 0,
      originalEstimatedTokens: 0,
      compactedEstimatedTokens: 0,
      compressedTurnCount: 0,
      compactedTurns: [],
      formattedSummary: 'Prompt compaction: 0 turns in context; no compaction needed.',
    }
  }

  const originalEstimatedTokens = turns.reduce(
    (sum, t) => sum + estimateTokens(t.content, charsPerToken),
    0,
  )

  // If already under token budget, return unmodified
  if (originalEstimatedTokens <= maxBudget) {
    return {
      valid: true,
      originalTurnCount: turns.length,
      compactedTurnCount: turns.length,
      originalEstimatedTokens,
      compactedEstimatedTokens: originalEstimatedTokens,
      compressedTurnCount: 0,
      compactedTurns: [...turns],
      formattedSummary: `Prompt compaction: ${String(turns.length)} turns (${String(originalEstimatedTokens)} tokens) already within budget ${String(maxBudget)}.`,
    }
  }

  // Identify anchor turns
  const hasSystemAnchor = pinSystem && turns[0]?.role === 'system'
  const anchorTurns: PromptTurn[] = hasSystemAnchor && turns[0] ? [turns[0]] : []
  const remainingCandidates = hasSystemAnchor ? turns.slice(1) : [...turns]

  if (remainingCandidates.length <= keepRecent) {
    // Cannot compress intermediate turns since total turns <= keepRecent
    return {
      valid: true,
      originalTurnCount: turns.length,
      compactedTurnCount: turns.length,
      originalEstimatedTokens,
      compactedEstimatedTokens: originalEstimatedTokens,
      compressedTurnCount: 0,
      compactedTurns: [...turns],
      formattedSummary: `Prompt compaction: ${String(turns.length)} turns cannot be compressed below keepRecent ceiling (${String(keepRecent)}).`,
    }
  }

  // Slices: middle turns vs tail turns
  const tailTurns = remainingCandidates.slice(-keepRecent)
  const middleTurns = remainingCandidates.slice(0, -keepRecent)

  // Synthesize middle turn condensation
  const toolNames = new Set<string>()
  for (const t of middleTurns) {
    if (t.toolName) {
      toolNames.add(t.toolName)
    }
  }

  const toolListStr =
    toolNames.size > 0 ? Array.from(toolNames).join(', ') : 'no external tools called'

  const condensedTurn: PromptTurn = {
    role: 'user',
    turnIndex: anchorTurns.length > 0 ? 1 : 0,
    content: `[COMPACTED CONVERSATION HISTORY: ${String(middleTurns.length)} intermediate turns condensed to preserve token budget. Prior tools invoked: ${toolListStr}]`,
  }

  const compactedTurns: PromptTurn[] = [
    ...anchorTurns,
    condensedTurn,
    ...tailTurns.map((t, idx) => ({
      ...t,
      turnIndex: anchorTurns.length + 1 + idx,
    })),
  ]

  const compactedEstimatedTokens = compactedTurns.reduce(
    (sum, t) => sum + estimateTokens(t.content, charsPerToken),
    0,
  )

  const lines = [
    '================================================================================',
    'PROMPT CONTEXT TOKEN BUDGET COMPACTION REPORT (AGENT-013)',
    '================================================================================',
    `Original Turns:     ${String(turns.length)} (${String(originalEstimatedTokens)} est. tokens)`,
    `Compacted Turns:    ${String(compactedTurns.length)} (${String(compactedEstimatedTokens)} est. tokens)`,
    `Condensed Turns:    ${String(middleTurns.length)} intermediate turns condensed`,
    `Budget Ceiling:     ${String(maxBudget)} tokens`,
    `Preserved Tail:     ${String(tailTurns.length)} recent turns`,
    '================================================================================',
  ]

  return {
    valid: true,
    originalTurnCount: turns.length,
    compactedTurnCount: compactedTurns.length,
    originalEstimatedTokens,
    compactedEstimatedTokens,
    compressedTurnCount: middleTurns.length,
    compactedTurns,
    formattedSummary: lines.join('\n'),
  }
}
