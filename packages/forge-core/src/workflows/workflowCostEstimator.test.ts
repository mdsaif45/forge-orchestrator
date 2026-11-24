import { describe, expect, it } from 'vitest'
import { DEFAULT_TEMPLATES_V2 } from '../templates/defaultTemplatesV2'
import { estimateWorkflowCost } from './workflowCostEstimator'

describe('Workflow DAG Cost & Token Estimator (WORK-017)', () => {
  it('estimates token and cost bounds for default workflow template', () => {
    const template = DEFAULT_TEMPLATES_V2[0]
    expect(template).toBeDefined()

    const report = estimateWorkflowCost(template)
    expect(report.valid).toBe(true)
    expect(report.templateId).toBe('cr-sdlc')
    expect(report.agentNodes).toBeGreaterThan(0)
    expect(report.minInputTokens).toBeGreaterThan(0)
    expect(report.maxInputTokens).toBeGreaterThan(report.minInputTokens)
    expect(report.minEstimatedCostUsd).toBeGreaterThan(0)
    expect(report.maxEstimatedCostUsd).toBeGreaterThan(report.minEstimatedCostUsd)
    expect(report.formattedSummary).toContain('WORKFLOW EXECUTION COST & TOKEN ESTIMATE')
  })

  it('fails closed with descriptive errors on invalid template schema (Axiom A2)', () => {
    const invalidTemplate = { id: 123, nodes: 'not-an-array' }
    const report = estimateWorkflowCost(invalidTemplate)

    expect(report.valid).toBe(false)
    expect(report.error).toBeDefined()
    expect(report.formattedSummary).toContain('WORKFLOW COST ESTIMATION FAILED')
  })

  it('factors in custom pricing options and turn ceilings (Axiom A5)', () => {
    const template = DEFAULT_TEMPLATES_V2[0]
    const report = estimateWorkflowCost(template, {
      inputPricePerMillion: 1.0,
      outputPricePerMillion: 2.0,
      maxFeedbackIterations: 5,
    })

    expect(report.valid).toBe(true)
    expect(report.maxFeedbackIterations).toBe(5)
    // Custom price yields higher estimated costs
    expect(report.maxEstimatedCostUsd).toBeGreaterThan(0.01)
  })
})
