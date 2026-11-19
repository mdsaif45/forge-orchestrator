import { workflowTemplateV2Schema } from '@shared/domain'

export interface WorkflowCostEstimateOptions {
  /** Multiplier for feedback/retry loop worst-case iterations (default: 3, Axiom A5). */
  readonly maxFeedbackIterations?: number | undefined
  /** Price in USD per 1M input tokens (default: $0.15). */
  readonly inputPricePerMillion?: number | undefined
  /** Price in USD per 1M output tokens (default: $0.60). */
  readonly outputPricePerMillion?: number | undefined
  /** Assumed average turn count per agent stage in normal execution (default: 5). */
  readonly averageTurnsPerAgent?: number | undefined
  /** Assumed maximum turn ceiling per agent stage (default: 15, Axiom A5). */
  readonly maxTurnsPerAgent?: number | undefined
}

export interface WorkflowCostEstimateReport {
  readonly valid: boolean
  readonly templateId: string
  readonly templateName: string
  readonly totalNodes: number
  readonly agentNodes: number
  readonly gateNodes: number
  readonly maxFeedbackIterations: number
  readonly minInputTokens: number
  readonly maxInputTokens: number
  readonly minOutputTokens: number
  readonly maxOutputTokens: number
  readonly minEstimatedCostUsd: number
  readonly maxEstimatedCostUsd: number
  readonly maxTurnsCeiling: number
  readonly formattedSummary: string
  readonly error?: string | undefined
}

/**
 * Performs static topological simulation and computes min/max token and USD bounds (Axioms A5, A6).
 */
export function estimateWorkflowCost(
  rawTemplate: unknown,
  options: WorkflowCostEstimateOptions = {},
): WorkflowCostEstimateReport {
  const parsed = workflowTemplateV2Schema.safeParse(rawTemplate)
  if (!parsed.success) {
    const errorMsg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    return {
      valid: false,
      templateId: 'unknown',
      templateName: 'unknown',
      totalNodes: 0,
      agentNodes: 0,
      gateNodes: 0,
      maxFeedbackIterations: 0,
      minInputTokens: 0,
      maxInputTokens: 0,
      minOutputTokens: 0,
      maxOutputTokens: 0,
      minEstimatedCostUsd: 0,
      maxEstimatedCostUsd: 0,
      maxTurnsCeiling: 0,
      formattedSummary: `WORKFLOW COST ESTIMATION FAILED: Invalid template schema (${errorMsg})`,
      error: errorMsg,
    }
  }

  const template = parsed.data
  const maxIterations = options.maxFeedbackIterations ?? 3
  const inputPricePerM = options.inputPricePerMillion ?? 0.15
  const outputPricePerM = options.outputPricePerMillion ?? 0.6
  const avgTurns = options.averageTurnsPerAgent ?? 5
  const maxTurns = options.maxTurnsPerAgent ?? 15

  let agentNodes = 0
  let gateNodes = 0

  for (const node of template.nodes) {
    if (node.type === 'agent') {
      agentNodes++
    } else {
      gateNodes++
    }
  }

  // Check if template has feedback edges
  const hasFeedbackEdges = template.edges.some((e) => e.condition !== undefined)
  const loopMultiplier = hasFeedbackEdges ? maxIterations : 1

  // Per agent node estimates:
  // - Prompt context: 1,500 base tokens
  // - Per-turn input: 400 tokens
  // - Per-turn output: 300 tokens
  const minAgentInput = 1500 + avgTurns * 300
  const minAgentOutput = avgTurns * 200

  const maxAgentInput = (2500 + maxTurns * 600) * loopMultiplier
  const maxAgentOutput = maxTurns * 400 * loopMultiplier

  const minInputTokens = agentNodes * minAgentInput
  const maxInputTokens = agentNodes * maxAgentInput
  const minOutputTokens = agentNodes * minAgentOutput
  const maxOutputTokens = agentNodes * maxAgentOutput

  const minCost =
    (minInputTokens / 1_000_000) * inputPricePerM + (minOutputTokens / 1_000_000) * outputPricePerM
  const maxCost =
    (maxInputTokens / 1_000_000) * inputPricePerM + (maxOutputTokens / 1_000_000) * outputPricePerM

  const minEstimatedCostUsd = Math.round(minCost * 10_000) / 10_000
  const maxEstimatedCostUsd = Math.round(maxCost * 10_000) / 10_000
  const maxTurnsCeiling = agentNodes * maxTurns * loopMultiplier

  const lines: string[] = [
    `WORKFLOW EXECUTION COST & TOKEN ESTIMATE: ${template.name} (${template.id})`,
    `  Total Nodes:             ${String(template.nodes.length)} (${String(agentNodes)} agent, ${String(gateNodes)} gate/verification)`,
    `  Feedback Multiplier:     ${String(loopMultiplier)}x (max iterations: ${String(maxIterations)})`,
    `  Max Turns Ceiling:       ${String(maxTurnsCeiling)} turns total`,
    `  Expected Input Tokens:   ${minInputTokens.toLocaleString()} – ${maxInputTokens.toLocaleString()}`,
    `  Expected Output Tokens:  ${minOutputTokens.toLocaleString()} – ${maxOutputTokens.toLocaleString()}`,
    `  Estimated Cost (USD):    $${minEstimatedCostUsd.toFixed(4)} – $${maxEstimatedCostUsd.toFixed(4)}`,
  ]

  return {
    valid: true,
    templateId: template.id,
    templateName: template.name,
    totalNodes: template.nodes.length,
    agentNodes,
    gateNodes,
    maxFeedbackIterations: maxIterations,
    minInputTokens,
    maxInputTokens,
    minOutputTokens,
    maxOutputTokens,
    minEstimatedCostUsd,
    maxEstimatedCostUsd,
    maxTurnsCeiling,
    formattedSummary: lines.join('\n'),
  }
}
