/**
 * WORK-029: Workflow Step Dependency Barrier & Fan-In Synchronization Gate.
 *
 * Evaluates prerequisite dependency outcomes following fan-out execution according
 * to configurable quorum policies (ALL_SUCCEEDED, AT_LEAST_ONE_SUCCEEDED, MAJORITY_SUCCEEDED,
 * FAIL_FAST_ANY) with fail-fast detection of impossible quorums.
 */

export type BarrierPolicy =
  'ALL_SUCCEEDED' | 'AT_LEAST_ONE_SUCCEEDED' | 'MAJORITY_SUCCEEDED' | 'FAIL_FAST_ANY'

export type DependencyOutcomeStatus = 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'PENDING'

export interface StepDependencyOutcome {
  stepId: string
  status: DependencyOutcomeStatus
  required: boolean
  error?: string | undefined
}

export interface BarrierDecision {
  barrierStepId: string
  policy: BarrierPolicy
  canProceed: boolean
  isSatisfied: boolean
  isImpossible: boolean
  totalDependencies: number
  succeededCount: number
  failedCount: number
  pendingCount: number
  skippedCount: number
  pendingStepIds: string[]
  failedStepIds: string[]
  summary: string
}

export function evaluateStepBarrier(
  barrierStepId: string,
  dependencies: StepDependencyOutcome[],
  policy: BarrierPolicy = 'ALL_SUCCEEDED',
): BarrierDecision {
  const trimmedId = barrierStepId.trim()
  if (!trimmedId) {
    throw new Error('Barrier step ID cannot be empty.')
  }

  const total = dependencies.length
  if (total === 0) {
    return {
      barrierStepId: trimmedId,
      policy,
      canProceed: true,
      isSatisfied: true,
      isImpossible: false,
      totalDependencies: 0,
      succeededCount: 0,
      failedCount: 0,
      pendingCount: 0,
      skippedCount: 0,
      pendingStepIds: [],
      failedStepIds: [],
      summary: 'No dependencies defined. Barrier gate opened immediately.',
    }
  }

  let succeededCount = 0
  let failedCount = 0
  let pendingCount = 0
  let skippedCount = 0

  const pendingStepIds: string[] = []
  const failedStepIds: string[] = []
  let hasFailedRequired = false

  for (const dep of dependencies) {
    switch (dep.status) {
      case 'SUCCEEDED':
        succeededCount++
        break
      case 'FAILED':
        failedCount++
        failedStepIds.push(dep.stepId)
        if (dep.required) {
          hasFailedRequired = true
        }
        break
      case 'PENDING':
        pendingCount++
        pendingStepIds.push(dep.stepId)
        break
      case 'SKIPPED':
        skippedCount++
        if (dep.required) {
          hasFailedRequired = true
        }
        break
    }
  }

  let isSatisfied = false
  let isImpossible = false

  if (hasFailedRequired) {
    isImpossible = true
  } else {
    switch (policy) {
      case 'ALL_SUCCEEDED': {
        if (failedCount > 0) {
          isImpossible = true
        } else if (pendingCount === 0 && succeededCount === total) {
          isSatisfied = true
        }
        break
      }
      case 'FAIL_FAST_ANY': {
        if (failedCount > 0) {
          isImpossible = true
        } else if (pendingCount === 0 && succeededCount + skippedCount === total) {
          isSatisfied = true
        }
        break
      }
      case 'AT_LEAST_ONE_SUCCEEDED': {
        if (succeededCount >= 1) {
          isSatisfied = true
        } else if (pendingCount === 0 && succeededCount === 0) {
          isImpossible = true
        }
        break
      }
      case 'MAJORITY_SUCCEEDED': {
        const majorityThreshold = Math.floor(total / 2) + 1
        if (succeededCount >= majorityThreshold) {
          isSatisfied = true
        } else if (succeededCount + pendingCount < majorityThreshold) {
          isImpossible = true
        }
        break
      }
    }
  }

  const canProceed = isSatisfied && !isImpossible

  let summary: string
  if (canProceed) {
    summary = `Barrier satisfied under policy ${policy} (${String(succeededCount)}/${String(total)} succeeded).`
  } else if (isImpossible) {
    summary = `Barrier impossible under policy ${policy}: cannot satisfy quorum (${String(failedCount)} failed, required failure: ${String(hasFailedRequired)}).`
  } else {
    summary = `Barrier pending under policy ${policy}: waiting for ${String(pendingCount)} active branch(es).`
  }

  return {
    barrierStepId: trimmedId,
    policy,
    canProceed,
    isSatisfied,
    isImpossible,
    totalDependencies: total,
    succeededCount,
    failedCount,
    pendingCount,
    skippedCount,
    pendingStepIds,
    failedStepIds,
    summary,
  }
}
