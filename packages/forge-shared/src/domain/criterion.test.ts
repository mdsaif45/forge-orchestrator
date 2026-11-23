import { describe, expect, it } from 'vitest'
import {
  criterionResultSchema,
  formatCriterionResult,
  stepEvidenceSchema,
  evidenceIdSchema,
  taskIdSchema,
  stepIdSchema,
  shaSchema,
  actorSchema,
  type CriterionResult,
  type StepEvidence,
} from './index'

describe('criterion domain contract (CRIT-001)', () => {
  it('parses valid criterion result and formats display string', () => {
    const valid: CriterionResult = {
      kind: 'tests',
      description: 'Test suite passes',
      verdict: 'pass',
      reason: '1,125 tests passed with 0 failures',
      evidenceId: 'e-1234',
    }

    const parsed = criterionResultSchema.parse(valid)
    expect(parsed.kind).toBe('tests')
    expect(parsed.verdict).toBe('pass')

    const formatted = formatCriterionResult(parsed)
    expect(formatted).toContain('✓ [tests] Test suite passes')
    expect(formatted).toContain('1,125 tests passed')
  })

  it('formats failed and unknown criterion results properly', () => {
    const failed = criterionResultSchema.parse({
      kind: 'build',
      description: 'Build compiles cleanly',
      verdict: 'fail',
      reason: 'TypeScript compiler failed with 2 errors',
      evidenceId: null,
    })
    expect(formatCriterionResult(failed)).toContain('✗ [build]')

    const unknown = criterionResultSchema.parse({
      kind: 'no-assumptions',
      description: 'No unverified assumptions',
      verdict: 'unknown',
      reason: 'Report was absent',
      evidenceId: null,
    })
    expect(formatCriterionResult(unknown)).toContain('? [no-assumptions]')
  })

  it('validates StepEvidence with criteria array and defaults to empty array', () => {
    const baseInput = {
      id: evidenceIdSchema.parse('11111111-1111-4111-8111-111111111111'),
      taskId: taskIdSchema.parse('22222222-2222-4222-8222-222222222222'),
      stepId: stepIdSchema.parse('33333333-3333-4333-8333-333333333333'),
      workflowId: null,
      actor: actorSchema.parse('agent:implementer'),
      baseSha: shaSchema.parse('0123456789abcdef0123456789abcdef01234567'),
      headSha: null,
      changeSet: null,
      commandArtifacts: [],
      discrepancies: [],
      passed: true,
      verdict: 'pass' as const,
      findings: [],
      falseClaims: [],
      recordedAt: new Date().toISOString(),
    }

    // Defaulting to empty array when omitted
    const parsedDefault = stepEvidenceSchema.parse(baseInput)
    expect(parsedDefault.criteria).toEqual([])

    // Preserving supplied criteria
    const parsedWithCriteria: StepEvidence = stepEvidenceSchema.parse({
      ...baseInput,
      criteria: [
        {
          kind: 'tests',
          description: 'Tests pass',
          verdict: 'pass',
          reason: 'All tests green',
          evidenceId: null,
        },
      ],
    })
    expect(parsedWithCriteria.criteria).toHaveLength(1)
    expect(parsedWithCriteria.criteria[0]?.kind).toBe('tests')
  })
})
