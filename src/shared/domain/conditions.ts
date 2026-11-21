import type { WorkflowArtifact } from './workflowGraph'
import type { EdgeCondition } from './workflowGraph'

/**
 * Context provided to pure condition evaluation.
 */
export interface ConditionEvaluationContext {
  readonly inputArtifacts?: readonly WorkflowArtifact[] | undefined
  readonly incomingSlots?: ReadonlyMap<string, WorkflowArtifact> | undefined
  readonly initialContext?: Readonly<Record<string, string>> | undefined
  readonly iteration?: number | undefined
}

/**
 * Resolves a reference path against the evaluation context.
 *
 * Supported references:
 * - `run.iteration` or `iteration`: Returns the run's current iteration number.
 * - `context.<key>`: Returns string value from initialContext.
 * - `artifacts.<slotName>.<jsonPath>`: Resolves a JSON property from the artifact bound to <slotName>.
 *
 * Returns `undefined` if the path cannot be resolved or is missing.
 */
export function resolveConditionRef(ref: string, ctx: ConditionEvaluationContext): unknown {
  if (ref === 'run.iteration' || ref === 'iteration') {
    return ctx.iteration ?? 1
  }

  if (ref.startsWith('context.')) {
    const key = ref.slice('context.'.length)
    return ctx.initialContext?.[key]
  }

  if (ref.startsWith('artifacts.')) {
    const pathParts = ref.slice('artifacts.'.length).split('.')
    const slotName = pathParts[0]
    if (!slotName) return undefined

    // Find artifact by slot name or kind
    let artifact = ctx.incomingSlots?.get(slotName)
    if (!artifact && ctx.inputArtifacts) {
      artifact = ctx.inputArtifacts.find((a) => a.kind === slotName || a.title === slotName)
    }
    if (!artifact) return undefined

    const propertyParts = pathParts.slice(1)
    if (propertyParts.length === 0) {
      return artifact.content
    }

    try {
      let current: unknown = JSON.parse(artifact.content)
      for (const part of propertyParts) {
        if (current === null || current === undefined || typeof current !== 'object') {
          return undefined
        }
        current = (current as Record<string, unknown>)[part]
      }
      return current
    } catch {
      // Artifact content is not valid JSON; nested property resolution fails
      return undefined
    }
  }

  return undefined
}

/**
 * Evaluates a single EdgeCondition against an immutable evaluation context.
 *
 * Enforces Gate 1 Fail-Closed Invariants:
 * - Missing references (`undefined`) fail closed: they NEVER satisfy `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, or `not_in`.
 * - Explicit `null` is distinct from missing `undefined`.
 * - `exists` operator: `value === false` tests for missing (`undefined`), while default/`true` tests for defined (`!== undefined`).
 * - Strict type equality: no type coercion between strings, numbers, or booleans.
 */
export function evaluateCondition(
  condition: EdgeCondition,
  ctx: ConditionEvaluationContext,
): boolean {
  if (condition.predicates.length === 0) {
    return false
  }

  const results = condition.predicates.map((predicate) => {
    const actual = resolveConditionRef(predicate.ref, ctx)

    // Operator: exists
    if (predicate.operator === 'exists') {
      if (predicate.value === false) {
        return actual === undefined
      }
      return actual !== undefined
    }

    // Gate 1: If reference is missing (undefined), all value-comparison operators fail closed
    if (actual === undefined) {
      return false
    }

    switch (predicate.operator) {
      case 'eq':
        return actual === predicate.value

      case 'neq':
        return actual !== predicate.value

      case 'gt':
        return (
          typeof actual === 'number' &&
          typeof predicate.value === 'number' &&
          !Number.isNaN(actual) &&
          actual > predicate.value
        )

      case 'gte':
        return (
          typeof actual === 'number' &&
          typeof predicate.value === 'number' &&
          !Number.isNaN(actual) &&
          actual >= predicate.value
        )

      case 'lt':
        return (
          typeof actual === 'number' &&
          typeof predicate.value === 'number' &&
          !Number.isNaN(actual) &&
          actual < predicate.value
        )

      case 'lte':
        return (
          typeof actual === 'number' &&
          typeof predicate.value === 'number' &&
          !Number.isNaN(actual) &&
          actual <= predicate.value
        )

      case 'in':
        if (!Array.isArray(predicate.value)) return false
        return (predicate.value as readonly unknown[]).includes(actual)

      case 'not_in':
        if (!Array.isArray(predicate.value)) return false
        return !(predicate.value as readonly unknown[]).includes(actual)

      default:
        return false
    }
  })

  if (condition.mode === 'any') {
    return results.some(Boolean)
  }

  // Default: 'all'
  return results.every(Boolean)
}
