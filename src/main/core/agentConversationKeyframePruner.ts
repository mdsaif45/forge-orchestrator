/**
 * Conversation token budget hierarchical compressor and keyframe pruner.
 *
 * Preserves anchor objectives and decision keyframes while progressively
 * compacting ephemeral intermediate tool observations to enforce hard
 * context window boundaries (A1, A4, A5).
 */

export type KeyframeRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ConversationTurnNode {
  readonly id: string
  readonly role: KeyframeRole
  content: string
  tokensEst: number
  readonly isAnchor: boolean
  importanceScore: number
  readonly toolName?: string | undefined
  readonly turnIndex: number
}

export interface PrunerConfig {
  /** Target maximum context token budget. Defaults to 4096. */
  readonly maxContextTokens?: number | undefined
  /** Approximate characters per token for estimation. Defaults to 4. */
  readonly charactersPerToken?: number | undefined
  /** List of tool names considered ephemeral whose outputs can be pruned first. */
  readonly ephemeralToolNames?: readonly string[] | undefined
  /** Number of most recent turns guaranteed preservation as active working context. Defaults to 2. */
  readonly preserveLatestTurnsCount?: number | undefined
}

export interface PruningPlan {
  readonly originalTurnCount: number
  readonly retainedTurnCount: number
  readonly prunedTurnCount: number
  readonly originalTokensEst: number
  readonly prunedTokensEst: number
  readonly tokenReductionPercentage: number
  readonly turns: readonly ConversationTurnNode[]
}

const DEFAULT_EPHEMERAL_TOOLS = new Set(['list_dir', 'search_files', 'read_file'])

export class AgentConversationKeyframePruner {
  private readonly maxContextTokens: number
  private readonly charactersPerToken: number
  private readonly ephemeralTools: Set<string>
  private readonly preserveLatestTurnsCount: number

  constructor(config: PrunerConfig = {}) {
    this.maxContextTokens = Math.max(16, config.maxContextTokens ?? 4096)
    this.charactersPerToken = Math.max(1, config.charactersPerToken ?? 4)
    this.ephemeralTools = config.ephemeralToolNames
      ? new Set(config.ephemeralToolNames)
      : DEFAULT_EPHEMERAL_TOOLS
    this.preserveLatestTurnsCount = Math.max(1, config.preserveLatestTurnsCount ?? 2)
  }

  /**
   * Estimates token count from string length.
   */
  estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / this.charactersPerToken))
  }

  /**
   * Analyzes an input sequence of conversation turns and constructs scored keyframe nodes.
   */
  buildKeyframeTree(
    rawTurns: readonly {
      readonly id?: string | undefined
      readonly role: KeyframeRole
      readonly content: string
      readonly toolName?: string | undefined
    }[],
  ): ConversationTurnNode[] {
    const totalTurns = rawTurns.length
    const nodes: ConversationTurnNode[] = []

    for (let i = 0; i < totalTurns; i += 1) {
      const turn = rawTurns[i]
      if (!turn) continue

      const id = turn.id ?? `turn-${String(i)}`
      const tokensEst = this.estimateTokens(turn.content)

      // Anchor rules: System message and first user goal are permanent anchors
      const isSystemAnchor = turn.role === 'system' && i === 0
      const isInitialUserAnchor =
        turn.role === 'user' && !nodes.some((n) => n.role === 'user' && n.isAnchor)
      const isRecentWorkingTurn = i >= totalTurns - this.preserveLatestTurnsCount

      const isAnchor = isSystemAnchor || isInitialUserAnchor

      let importanceScore = 50 // Base score

      if (isSystemAnchor) {
        importanceScore = 100
      } else if (isInitialUserAnchor) {
        importanceScore = 90
      } else if (isRecentWorkingTurn) {
        importanceScore = 80 + (i - (totalTurns - this.preserveLatestTurnsCount)) * 5
      } else if (turn.role === 'tool') {
        const isEphemeral = turn.toolName ? this.ephemeralTools.has(turn.toolName) : true
        importanceScore = isEphemeral ? 15 : 35
      } else if (turn.role === 'assistant') {
        importanceScore = 60
      }

      nodes.push({
        id,
        role: turn.role,
        content: turn.content,
        tokensEst,
        isAnchor,
        importanceScore,
        toolName: turn.toolName,
        turnIndex: i,
      })
    }

    return nodes
  }

  /**
   * Prunes low-importance turns and truncates ephemeral observations until context fits target budget.
   */
  prune(
    rawTurns: readonly {
      readonly id?: string | undefined
      readonly role: KeyframeRole
      readonly content: string
      readonly toolName?: string | undefined
    }[],
  ): PruningPlan {
    const tree = this.buildKeyframeTree(rawTurns)
    const originalTurnCount = tree.length
    const originalTokensEst = tree.reduce((acc, t) => acc + t.tokensEst, 0)

    if (originalTokensEst <= this.maxContextTokens) {
      return {
        originalTurnCount,
        retainedTurnCount: originalTurnCount,
        prunedTurnCount: 0,
        originalTokensEst,
        prunedTokensEst: originalTokensEst,
        tokenReductionPercentage: 0,
        turns: tree,
      }
    }

    let currentTokens = originalTokensEst
    // Candidate turns eligible for pruning (non-anchors, sorted ascending by importance)
    const candidates = tree
      .filter((node) => !node.isAnchor)
      .sort((a, b) => a.importanceScore - b.importanceScore)

    // Phase 1: Truncate large tool outputs
    for (const node of candidates) {
      if (currentTokens <= this.maxContextTokens) break
      if (node.role === 'tool' && node.tokensEst > 64) {
        const truncatedContent = `[Truncated observation: output exceeded token budget. Original size: ${String(node.content.length)} chars]`
        const newTokens = this.estimateTokens(truncatedContent)
        const saved = node.tokensEst - newTokens

        node.content = truncatedContent
        node.tokensEst = newTokens
        currentTokens -= saved
      }
    }

    // Phase 2: If still exceeding, discard lowest importance non-anchor nodes
    const discardedIds = new Set<string>()
    for (const node of candidates) {
      if (currentTokens <= this.maxContextTokens) break
      discardedIds.add(node.id)
      currentTokens -= node.tokensEst
    }

    const retainedTurns = tree.filter((node) => !discardedIds.has(node.id))
    const prunedTokensEst = retainedTurns.reduce((acc, t) => acc + t.tokensEst, 0)
    const tokenReductionPercentage =
      originalTokensEst > 0
        ? Math.round(((originalTokensEst - prunedTokensEst) / originalTokensEst) * 100)
        : 0

    return {
      originalTurnCount,
      retainedTurnCount: retainedTurns.length,
      prunedTurnCount: discardedIds.size,
      originalTokensEst,
      prunedTokensEst,
      tokenReductionPercentage,
      turns: retainedTurns,
    }
  }
}
