import { describe, it, expect } from 'vitest'
import { evaluateStepPreconditions, type StepPrecondition } from './stepPreconditionEvaluator'

describe('StepPreconditionEvaluator (WORK-024)', () => {
  it('passes when no preconditions are specified', () => {
    const res = evaluateStepPreconditions({})
    expect(res.pass).toBe(true)
    expect(res.shouldSkip).toBe(false)
    expect(res.formattedSummary).toContain('PRECONDITIONS PASSED')
  })

  it('validates presence of required artifacts', () => {
    const preconditions: StepPrecondition = {
      requiredArtifacts: ['spec.md', 'diff.patch'],
    }

    const failed = evaluateStepPreconditions(preconditions, {
      existingArtifacts: ['spec.md'],
    })
    expect(failed.pass).toBe(false)
    expect(failed.shouldSkip).toBe(true)
    expect(failed.missingArtifacts).toContain('diff.patch')
    expect(failed.skipReason).toContain('diff.patch')

    const passed = evaluateStepPreconditions(preconditions, {
      existingArtifacts: ['spec.md', 'diff.patch', 'extra.txt'],
    })
    expect(passed.pass).toBe(true)
    expect(passed.shouldSkip).toBe(false)
    expect(passed.missingArtifacts).toHaveLength(0)
  })

  it('validates presence and non-emptiness of environment variables', () => {
    const preconditions: StepPrecondition = {
      requiredEnv: ['FORGE_API_KEY', 'DEPLOY_ENV'],
    }

    const failed = evaluateStepPreconditions(preconditions, {
      environment: { FORGE_API_KEY: 'test-key', DEPLOY_ENV: '' },
    })
    expect(failed.pass).toBe(false)
    expect(failed.missingEnv).toContain('DEPLOY_ENV')

    const passed = evaluateStepPreconditions(preconditions, {
      environment: { FORGE_API_KEY: 'test-key', DEPLOY_ENV: 'production' },
    })
    expect(passed.pass).toBe(true)
  })

  it('verifies prior stage completion statuses', () => {
    const preconditions: StepPrecondition = {
      requiredPriorStages: {
        lint: 'success',
        build: 'success',
      },
    }

    const failed = evaluateStepPreconditions(preconditions, {
      completedStages: {
        lint: { status: 'success' },
        build: { status: 'failure', exitCode: 1 },
      },
    })
    expect(failed.pass).toBe(false)
    expect(failed.unmetStages[0]).toContain('build (expected "success", found "failure")')

    const passed = evaluateStepPreconditions(preconditions, {
      completedStages: {
        lint: { status: 'success' },
        build: { status: 'success' },
      },
    })
    expect(passed.pass).toBe(true)
  })

  it('evaluates boolean and equality predicate expressions', () => {
    const preconditions: StepPrecondition = {
      predicateExpression: 'options.runE2E == true',
    }

    const failed = evaluateStepPreconditions(preconditions, {
      variables: { options: { runE2E: false } },
    })
    expect(failed.pass).toBe(false)
    expect(failed.skipReason).toContain('options.runE2E == true')

    const passed = evaluateStepPreconditions(preconditions, {
      variables: { options: { runE2E: true } },
    })
    expect(passed.pass).toBe(true)
  })

  it('formats descriptive skip summary when multiple criteria fail', () => {
    const preconditions: StepPrecondition = {
      requiredArtifacts: ['missing.art'],
      requiredEnv: ['SECRET_KEY'],
    }

    const res = evaluateStepPreconditions(preconditions, {
      existingArtifacts: [],
      environment: {},
    })

    expect(res.pass).toBe(false)
    expect(res.shouldSkip).toBe(true)
    expect(res.formattedSummary).toContain('STEP SKIPPED')
    expect(res.formattedSummary).toContain('missing.art')
    expect(res.formattedSummary).toContain('SECRET_KEY')
  })
})
