import { createHash } from 'node:crypto'

export type ToolSideEffectClass = 'READ_ONLY' | 'MUTATING' | 'IDEMPOTENT_WRITE'

export interface SpeculativeToolInvocation {
  readonly id: string
  readonly toolName: string
  readonly parameters?: Record<string, unknown>
  readonly dependencies?: readonly string[]
  readonly sideEffectClass?: ToolSideEffectClass
}

export interface SpeculativeExecutionSupervisorConfig {
  readonly defaultSideEffectClass?: ToolSideEffectClass
  readonly readOnlyPrefixes?: readonly string[]
  readonly mutatingPrefixes?: readonly string[]
  readonly allowSpeculativeIdempotent?: boolean
}

export interface SpeculativeExecutionPlan {
  readonly planId: string
  readonly totalInvocations: number
  readonly speculativeBatch: readonly string[]
  readonly sequentialPipeline: readonly string[]
  readonly rollbackSequence: readonly string[]
  readonly dependencyGraph: Record<string, readonly string[]>
}

export interface SpeculativeInvocationResult {
  readonly id: string
  readonly toolName: string
  readonly success: boolean
  readonly output?: unknown
  readonly error?: string
  readonly speculativelyExecuted: boolean
  readonly committed: boolean
}

export interface SpeculativeExecutionSummary {
  readonly planId: string
  readonly totalCount: number
  readonly speculativeCount: number
  readonly sequentialCount: number
  readonly committedCount: number
  readonly discardedCount: number
  readonly rolledBackCount: number
  readonly rollbackTriggered: boolean
  readonly results: readonly SpeculativeInvocationResult[]
  readonly rollbackLog: readonly string[]
}

export interface SpeculativeExecutionHandlers {
  readonly execute: (invocation: SpeculativeToolInvocation) => Promise<unknown>
  readonly rollback?: (
    invocation: SpeculativeToolInvocation,
    previousOutput: unknown,
  ) => Promise<void>
  readonly validatePreconditions?: (
    speculativeOutputs: Record<string, unknown>,
  ) => boolean | Promise<boolean>
}

const DEFAULT_READ_ONLY_PREFIXES = [
  'read_',
  'get_',
  'list_',
  'search_',
  'find_',
  'describe_',
  'inspect_',
  'view_',
  'query_',
  'check_',
]

const DEFAULT_MUTATING_PREFIXES = [
  'write_',
  'edit_',
  'delete_',
  'run_',
  'execute_',
  'create_',
  'update_',
  'patch_',
  'drop_',
  'alter_',
]

export class AgentToolSpeculativeExecutionSupervisor {
  private readonly config: Required<SpeculativeExecutionSupervisorConfig>

  constructor(config?: SpeculativeExecutionSupervisorConfig) {
    this.config = {
      defaultSideEffectClass: config?.defaultSideEffectClass ?? 'MUTATING',
      readOnlyPrefixes: config?.readOnlyPrefixes ?? DEFAULT_READ_ONLY_PREFIXES,
      mutatingPrefixes: config?.mutatingPrefixes ?? DEFAULT_MUTATING_PREFIXES,
      allowSpeculativeIdempotent: config?.allowSpeculativeIdempotent ?? false,
    }
  }

  public classifyTool(toolName: string, overrideClass?: ToolSideEffectClass): ToolSideEffectClass {
    if (overrideClass) {
      return overrideClass
    }
    const lower = toolName.toLowerCase()
    for (const prefix of this.config.readOnlyPrefixes) {
      if (lower.startsWith(prefix)) {
        return 'READ_ONLY'
      }
    }
    for (const prefix of this.config.mutatingPrefixes) {
      if (lower.startsWith(prefix)) {
        return 'MUTATING'
      }
    }
    return this.config.defaultSideEffectClass
  }

  public buildPlan(invocations: readonly SpeculativeToolInvocation[]): SpeculativeExecutionPlan {
    const nodeMap = new Map<string, SpeculativeToolInvocation>()
    const dependencyGraph: Record<string, readonly string[]> = {}

    for (const inv of invocations) {
      if (nodeMap.has(inv.id)) {
        throw new Error(`Duplicate invocation ID detected: "${inv.id}"`)
      }
      nodeMap.set(inv.id, inv)
      dependencyGraph[inv.id] = inv.dependencies ? [...inv.dependencies] : []
    }

    // Validate that all declared dependencies exist
    for (const [id, deps] of Object.entries(dependencyGraph)) {
      for (const dep of deps) {
        if (!nodeMap.has(dep)) {
          throw new Error(`Missing dependency "${dep}" declared by invocation "${id}"`)
        }
      }
    }

    // Check for dependency cycles using DFS
    const visited = new Set<string>()
    const visiting = new Set<string>()

    const detectCycle = (id: string, path: string[]): void => {
      visiting.add(id)
      for (const dep of dependencyGraph[id] ?? []) {
        if (visiting.has(dep)) {
          throw new Error(`Dependency cycle detected: ${[...path, id, dep].join(' -> ')}`)
        }
        if (!visited.has(dep)) {
          detectCycle(dep, [...path, id])
        }
      }
      visiting.delete(id)
      visited.add(id)
    }

    for (const id of Object.keys(dependencyGraph)) {
      if (!visited.has(id)) {
        detectCycle(id, [])
      }
    }

    // Evaluate side-effect class and transitive dependencies
    const isSpeculatableCache = new Map<string, boolean>()

    const canSpeculate = (id: string): boolean => {
      if (isSpeculatableCache.has(id)) {
        return isSpeculatableCache.get(id) ?? false
      }
      const inv = nodeMap.get(id)
      if (!inv) {
        return false
      }
      const sideEffect = this.classifyTool(inv.toolName, inv.sideEffectClass)
      const isRead =
        sideEffect === 'READ_ONLY' ||
        (sideEffect === 'IDEMPOTENT_WRITE' && this.config.allowSpeculativeIdempotent)

      if (!isRead) {
        isSpeculatableCache.set(id, false)
        return false
      }

      // Must also have all dependencies speculatable
      const deps = dependencyGraph[id] ?? []
      for (const dep of deps) {
        if (!canSpeculate(dep)) {
          isSpeculatableCache.set(id, false)
          return false
        }
      }

      isSpeculatableCache.set(id, true)
      return true
    }

    const speculativeBatch: string[] = []
    const sequentialPipeline: string[] = []
    const mutatingNodes: string[] = []

    for (const inv of invocations) {
      const sideEffect = this.classifyTool(inv.toolName, inv.sideEffectClass)
      if (canSpeculate(inv.id)) {
        speculativeBatch.push(inv.id)
      } else {
        sequentialPipeline.push(inv.id)
        if (sideEffect === 'MUTATING') {
          mutatingNodes.push(inv.id)
        }
      }
    }

    const rollbackSequence = [...mutatingNodes].reverse()
    const planHash = createHash('sha256')
      .update(JSON.stringify({ invocations, speculativeBatch, sequentialPipeline }))
      .digest('hex')
      .slice(0, 16)

    return {
      planId: `spec-plan-${planHash}`,
      totalInvocations: invocations.length,
      speculativeBatch,
      sequentialPipeline,
      rollbackSequence,
      dependencyGraph,
    }
  }

  public async executePlan(
    plan: SpeculativeExecutionPlan,
    invocations: readonly SpeculativeToolInvocation[],
    handlers: SpeculativeExecutionHandlers,
  ): Promise<SpeculativeExecutionSummary> {
    const nodeMap = new Map<string, SpeculativeToolInvocation>()
    for (const inv of invocations) {
      nodeMap.set(inv.id, inv)
    }

    const results: SpeculativeInvocationResult[] = []
    const speculativeOutputs: Record<string, unknown> = {}
    let discardedCount = 0
    let committedCount = 0
    let rollbackTriggered = false
    const rollbackLog: string[] = []
    const executedMutatingInvocations: {
      invocation: SpeculativeToolInvocation
      output: unknown
    }[] = []

    // 1. Speculative execution batch (concurrent)
    const speculativeTasks = plan.speculativeBatch.map(async (id) => {
      const inv = nodeMap.get(id)
      if (!inv) {
        throw new Error(`Invocation not found: ${id}`)
      }
      try {
        const output = await handlers.execute(inv)
        return { id, success: true, output, error: undefined }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { id, success: false, output: undefined, error: message }
      }
    })

    const settledSpeculative = await Promise.all(speculativeTasks)
    let speculativeAllOk = true
    for (const res of settledSpeculative) {
      if (!res.success) {
        speculativeAllOk = false
      } else {
        speculativeOutputs[res.id] = res.output
      }
    }

    // 2. Precondition validation gate
    let preconditionsPassed = speculativeAllOk
    if (speculativeAllOk && handlers.validatePreconditions) {
      try {
        const valid = await handlers.validatePreconditions(speculativeOutputs)
        if (!valid) {
          preconditionsPassed = false
        }
      } catch {
        preconditionsPassed = false
      }
    }

    if (!preconditionsPassed) {
      // Discard all speculative results fail-closed
      for (const res of settledSpeculative) {
        const inv = nodeMap.get(res.id)
        results.push({
          id: res.id,
          toolName: inv?.toolName ?? 'unknown',
          success: false,
          error: res.error ?? 'Speculative result discarded due to validation gate failure',
          speculativelyExecuted: true,
          committed: false,
        })
        discardedCount++
      }

      return {
        planId: plan.planId,
        totalCount: plan.totalInvocations,
        speculativeCount: plan.speculativeBatch.length,
        sequentialCount: plan.sequentialPipeline.length,
        committedCount: 0,
        discardedCount,
        rolledBackCount: 0,
        rollbackTriggered: false,
        results,
        rollbackLog: ['Speculative execution discarded at validation gate'],
      }
    }

    // Commit speculative results
    for (const res of settledSpeculative) {
      const inv = nodeMap.get(res.id)
      results.push({
        id: res.id,
        toolName: inv?.toolName ?? 'unknown',
        success: true,
        output: res.output,
        speculativelyExecuted: true,
        committed: true,
      })
      committedCount++
    }

    // 3. Sequential pipeline
    for (const id of plan.sequentialPipeline) {
      const inv = nodeMap.get(id)
      if (!inv) {
        continue
      }
      try {
        const output = await handlers.execute(inv)
        results.push({
          id: inv.id,
          toolName: inv.toolName,
          success: true,
          output,
          speculativelyExecuted: false,
          committed: true,
        })
        committedCount++

        const sideEffect = this.classifyTool(inv.toolName, inv.sideEffectClass)
        if (sideEffect === 'MUTATING') {
          executedMutatingInvocations.push({ invocation: inv, output })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        results.push({
          id: inv.id,
          toolName: inv.toolName,
          success: false,
          error: message,
          speculativelyExecuted: false,
          committed: false,
        })

        // Sequential step failed -> trigger rollback sequence for previously executed mutating steps
        rollbackTriggered = true
        rollbackLog.push(`Pipeline aborted at step ${inv.id}: ${message}`)

        if (handlers.rollback) {
          for (const item of [...executedMutatingInvocations].reverse()) {
            try {
              await handlers.rollback(item.invocation, item.output)
              rollbackLog.push(`Successfully rolled back ${item.invocation.id}`)
            } catch (rbErr) {
              const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr)
              rollbackLog.push(`Failed to roll back ${item.invocation.id}: ${rbMsg}`)
            }
          }
        }
        break
      }
    }

    return {
      planId: plan.planId,
      totalCount: plan.totalInvocations,
      speculativeCount: plan.speculativeBatch.length,
      sequentialCount: plan.sequentialPipeline.length,
      committedCount,
      discardedCount,
      rolledBackCount: rollbackTriggered ? executedMutatingInvocations.length : 0,
      rollbackTriggered,
      results,
      rollbackLog,
    }
  }
}
