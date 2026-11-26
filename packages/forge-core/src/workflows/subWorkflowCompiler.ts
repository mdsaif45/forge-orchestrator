import { createHash } from 'node:crypto'
import {
  getTopologicalSort,
  validateWorkflowGraph,
  workflowTemplateV2Schema,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowTemplateV2,
} from '@shared/domain'
import { validateTemplateGraph } from './validation'

export type FailureIsolationMode = 'FAIL_CLOSED' | 'CONTAIN_TO_SUBFLOW' | 'RETRY_SUBFLOW'

export interface SlotMapping {
  readonly parentSlot: string
  readonly subWorkflowSlot: string
  readonly direction: 'input' | 'output'
  readonly required?: boolean | undefined
  readonly transformExpression?: string | undefined
}

export interface ExecutionBoundaryContract {
  readonly boundaryId: string
  readonly failureIsolation: FailureIsolationMode
  readonly maxNestingDepth?: number | undefined
  readonly inheritParentVariables?: boolean | undefined
  readonly scopedVariables?: Readonly<Record<string, string | number | boolean>> | undefined
  readonly timeoutCeilingMs?: number | undefined
}

export interface SubWorkflowNodeSpec {
  readonly invocationId: string
  readonly title: string
  readonly subWorkflowTemplateId: string
  readonly slotMappings: readonly SlotMapping[]
  readonly boundary: ExecutionBoundaryContract
  readonly nestedInvocations?: readonly SubWorkflowNodeSpec[] | undefined
}

export interface SubWorkflowLineageEntry {
  readonly compiledNodeId: string
  readonly originalNodeId: string
  readonly lineagePath: readonly string[]
  readonly nestingDepth: number
  readonly invocationId: string
  readonly templateId: string
  readonly boundaryId: string
  readonly failureIsolation: FailureIsolationMode
  readonly mappedInputs: Readonly<Record<string, string>>
  readonly mappedOutputs: Readonly<Record<string, string>>
  readonly scopedVariables: Readonly<Record<string, string | number | boolean>>
}

export interface NestedCompileInput {
  readonly rootTemplate: WorkflowTemplateV2
  readonly templateRegistry: Readonly<Record<string, WorkflowTemplateV2>>
  readonly invocations: readonly SubWorkflowNodeSpec[]
  readonly parentVariables?: Readonly<Record<string, string | number | boolean>> | undefined
  readonly nowIso?: string | undefined
}

export interface NestedCompilationResult {
  readonly compiledTemplate: WorkflowTemplateV2
  readonly lineageMap: Readonly<Record<string, SubWorkflowLineageEntry>>
  readonly entryNodesByInvocation: Readonly<Record<string, readonly string[]>>
  readonly exitNodesByInvocation: Readonly<Record<string, readonly string[]>>
  readonly boundaryContracts: readonly ExecutionBoundaryContract[]
  readonly topologicalOrder: readonly string[]
  readonly maxDepthReached: number
  readonly totalFlattenedNodes: number
  readonly compilationDigest: string
}

export class SubWorkflowCompilationError extends Error {
  constructor(message: string) {
    super(`Sub-workflow compilation error: ${message}`)
    this.name = 'SubWorkflowCompilationError'
  }
}

export class SubWorkflowCycleError extends SubWorkflowCompilationError {
  readonly recursionPath: readonly string[]

  constructor(recursionPath: readonly string[], reason = 'Circular sub-workflow recursion') {
    super(`${reason}: ${recursionPath.join(' -> ')}`)
    this.name = 'SubWorkflowCycleError'
    this.recursionPath = recursionPath
  }
}

export class SlotMappingError extends SubWorkflowCompilationError {
  readonly invocationId: string
  readonly slotName: string

  constructor(invocationId: string, slotName: string, message: string) {
    super(`Slot mapping error in "${invocationId}" for slot "${slotName}": ${message}`)
    this.name = 'SlotMappingError'
    this.invocationId = invocationId
    this.slotName = slotName
  }
}

export class TemplateNotFoundError extends SubWorkflowCompilationError {
  readonly templateId: string

  constructor(templateId: string) {
    super(`Referenced sub-workflow template "${templateId}" not found in registry`)
    this.name = 'TemplateNotFoundError'
    this.templateId = templateId
  }
}

interface ExpansionState {
  readonly nodes: WorkflowNode[]
  readonly edges: WorkflowEdge[]
  readonly entryNodeIds: string[]
  readonly exitNodeIds: string[]
}

const SCOPE_VAR_RE = /\$\{\{\s*scope\.([a-zA-Z0-9._-]+)\s*\}\}/g
const DEFAULT_MAX_DEPTH = 5

function resolveScopedText(
  text: string | undefined,
  vars: Readonly<Record<string, string | number | boolean>>,
): string | undefined {
  if (text === undefined) {
    return undefined
  }
  return text.replace(SCOPE_VAR_RE, (_full, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return String(vars[key])
    }
    return `\${{ scope.${key} }}`
  })
}

function validateAndComputeSlotMaps(
  spec: SubWorkflowNodeSpec,
  childTemplate: WorkflowTemplateV2,
): {
  readonly mappedInputs: Record<string, string>
  readonly mappedOutputs: Record<string, string>
} {
  const childInputs = new Set<string>()
  const childOutputs = new Set<string>()
  const requiredChildInputs = new Set<string>()

  for (const node of childTemplate.nodes) {
    for (const slot of node.inputs) {
      childInputs.add(slot.name)
      if (slot.required) {
        requiredChildInputs.add(slot.name)
      }
    }
    for (const out of node.outputs) {
      childOutputs.add(out.name)
    }
  }

  const mappedInputs: Record<string, string> = {}
  const mappedOutputs: Record<string, string> = {}

  for (const mapping of spec.slotMappings) {
    if (mapping.parentSlot.trim() === '' || mapping.subWorkflowSlot.trim() === '') {
      throw new SlotMappingError(
        spec.invocationId,
        mapping.subWorkflowSlot || mapping.parentSlot,
        'Both parentSlot and subWorkflowSlot must be non-empty',
      )
    }

    if (mapping.direction === 'input') {
      if (childInputs.size > 0 && !childInputs.has(mapping.subWorkflowSlot)) {
        throw new SlotMappingError(
          spec.invocationId,
          mapping.subWorkflowSlot,
          `Target input slot "${mapping.subWorkflowSlot}" is not declared in sub-workflow "${childTemplate.id}"`,
        )
      }
      if (mapping.subWorkflowSlot in mappedInputs) {
        throw new SlotMappingError(
          spec.invocationId,
          mapping.subWorkflowSlot,
          'Duplicate input slot mapping detected',
        )
      }
      mappedInputs[mapping.subWorkflowSlot] = mapping.parentSlot
    } else {
      if (childOutputs.size > 0 && !childOutputs.has(mapping.subWorkflowSlot)) {
        throw new SlotMappingError(
          spec.invocationId,
          mapping.subWorkflowSlot,
          `Source output slot "${mapping.subWorkflowSlot}" is not declared in sub-workflow "${childTemplate.id}"`,
        )
      }
      if (mapping.parentSlot in mappedOutputs) {
        throw new SlotMappingError(
          spec.invocationId,
          mapping.parentSlot,
          'Duplicate parent output slot target detected',
        )
      }
      mappedOutputs[mapping.parentSlot] = mapping.subWorkflowSlot
    }
  }

  for (const reqInput of requiredChildInputs) {
    if (!(reqInput in mappedInputs)) {
      throw new SlotMappingError(
        spec.invocationId,
        reqInput,
        `Required sub-workflow input slot "${reqInput}" is missing a SlotMapping`,
      )
    }
  }

  return { mappedInputs, mappedOutputs }
}

/**
 * Parameterized Reusable Sub-Workflow DAG Template Compiler (COMP-002).
 * Recursively flattens nested sub-workflow invocations into a single canonical executable WorkflowTemplateV2 DAG
 * while enforcing scoped variable isolation, slot remapping, failure boundary contracts, and lineage provenance.
 */
export class SubWorkflowCompiler {
  /**
   * Flattens and validates nested reusable sub-workflows into canonical WorkflowTemplateV2 + lineage metadata.
   */
  public compile(input: NestedCompileInput): NestedCompilationResult {
    const lineageMap: Record<string, SubWorkflowLineageEntry> = {}
    const entryNodesByInvocation: Record<string, readonly string[]> = {}
    const exitNodesByInvocation: Record<string, readonly string[]> = {}
    const boundaryContracts: ExecutionBoundaryContract[] = []

    let maxDepthReached = 0
    let edgeSeq = 1

    const expandGraph = (
      template: WorkflowTemplateV2,
      invocations: readonly SubWorkflowNodeSpec[],
      depth: number,
      lineagePrefix: readonly string[],
      inheritedVars: Readonly<Record<string, string | number | boolean>>,
      boundary: ExecutionBoundaryContract | null,
      mappedInputs: Readonly<Record<string, string>>,
      mappedOutputs: Readonly<Record<string, string>>,
      templateStack: readonly string[],
    ): ExpansionState => {
      if (depth > maxDepthReached) {
        maxDepthReached = depth
      }

      const invocationById = new Map<string, SubWorkflowNodeSpec>()
      for (const spec of invocations) {
        if (invocationById.has(spec.invocationId)) {
          throw new SubWorkflowCompilationError(
            `Duplicate SubWorkflowNodeSpec invocationId "${spec.invocationId}"`,
          )
        }
        invocationById.set(spec.invocationId, spec)
      }

      const compiledNodes: WorkflowNode[] = []
      const compiledEdges: WorkflowEdge[] = []
      const scopeEntryByOrig = new Map<string, readonly string[]>()
      const scopeExitByOrig = new Map<string, readonly string[]>()

      const scopePrefix = depth === 0 ? '' : `${lineagePrefix.slice(1).join('__')}__`

      for (const node of template.nodes) {
        const subSpec = invocationById.get(node.id)
        if (!subSpec) {
          const compiledNodeId = depth === 0 ? node.id : `${scopePrefix}${node.id}`
          const resolvedTitle = resolveScopedText(node.title, inheritedVars) ?? node.title
          const resolvedPrompt = resolveScopedText(node.config.systemPrompt, inheritedVars)
          const resolvedArgs = resolveScopedText(node.config.argsTemplate, inheritedVars)
          const timeoutCeiling = boundary?.timeoutCeilingMs
          const effectiveTimeout =
            node.config.timeoutMs !== undefined && timeoutCeiling !== undefined
              ? Math.min(node.config.timeoutMs, timeoutCeiling)
              : (node.config.timeoutMs ?? timeoutCeiling)

          compiledNodes.push({
            ...node,
            id: compiledNodeId,
            title: resolvedTitle,
            config: {
              ...node.config,
              ...(resolvedPrompt !== undefined ? { systemPrompt: resolvedPrompt } : {}),
              ...(resolvedArgs !== undefined ? { argsTemplate: resolvedArgs } : {}),
              ...(effectiveTimeout !== undefined ? { timeoutMs: effectiveTimeout } : {}),
            },
          })

          scopeEntryByOrig.set(node.id, [compiledNodeId])
          scopeExitByOrig.set(node.id, [compiledNodeId])

          lineageMap[compiledNodeId] = {
            compiledNodeId,
            originalNodeId: node.id,
            lineagePath: [...lineagePrefix, node.id],
            nestingDepth: depth,
            invocationId: lineagePrefix[lineagePrefix.length - 1] ?? 'root',
            templateId: template.id,
            boundaryId: boundary?.boundaryId ?? 'root-boundary',
            failureIsolation: boundary?.failureIsolation ?? 'FAIL_CLOSED',
            mappedInputs,
            mappedOutputs,
            scopedVariables: { ...inheritedVars },
          }
          continue
        }

        const childTemplate = input.templateRegistry[subSpec.subWorkflowTemplateId]
        if (!childTemplate) {
          throw new TemplateNotFoundError(subSpec.subWorkflowTemplateId)
        }

        const nextStack = [...templateStack, childTemplate.id]
        if (templateStack.includes(childTemplate.id)) {
          throw new SubWorkflowCycleError(nextStack)
        }

        const maxAllowedDepth = subSpec.boundary.maxNestingDepth ?? DEFAULT_MAX_DEPTH
        if (depth + 1 > maxAllowedDepth) {
          throw new SubWorkflowCycleError(
            nextStack,
            `Exceeded maximum nesting depth (${String(maxAllowedDepth)})`,
          )
        }

        const slotMaps = validateAndComputeSlotMaps(subSpec, childTemplate)
        boundaryContracts.push(subSpec.boundary)

        const childVars: Record<string, string | number | boolean> = subSpec.boundary
          .inheritParentVariables
          ? { ...inheritedVars, ...(subSpec.boundary.scopedVariables ?? {}) }
          : { ...(subSpec.boundary.scopedVariables ?? {}) }

        const childExpanded = expandGraph(
          childTemplate,
          subSpec.nestedInvocations ?? [],
          depth + 1,
          [...lineagePrefix, subSpec.invocationId],
          childVars,
          subSpec.boundary,
          slotMaps.mappedInputs,
          slotMaps.mappedOutputs,
          nextStack,
        )

        compiledNodes.push(...childExpanded.nodes)
        compiledEdges.push(...childExpanded.edges)
        scopeEntryByOrig.set(node.id, childExpanded.entryNodeIds)
        scopeExitByOrig.set(node.id, childExpanded.exitNodeIds)

        const fullInvocationKey =
          depth === 0 ? subSpec.invocationId : `${scopePrefix}${subSpec.invocationId}`
        entryNodesByInvocation[fullInvocationKey] = childExpanded.entryNodeIds
        exitNodesByInvocation[fullInvocationKey] = childExpanded.exitNodeIds
      }

      // Track original graph forward in-degrees / out-degrees to identify entry & exit boundaries
      const incomingCount = new Map<string, number>()
      const outgoingCount = new Map<string, number>()
      for (const node of template.nodes) {
        incomingCount.set(node.id, 0)
        outgoingCount.set(node.id, 0)
      }

      for (const edge of template.edges) {
        if (!edge.isFeedback) {
          incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1)
          outgoingCount.set(edge.source, (outgoingCount.get(edge.source) ?? 0) + 1)
        }

        const sourceExits = scopeExitByOrig.get(edge.source) ?? []
        const targetEntries = scopeEntryByOrig.get(edge.target) ?? []
        for (const srcId of sourceExits) {
          for (const tgtId of targetEntries) {
            compiledEdges.push({
              ...edge,
              id: `compiled-edge-${String(edgeSeq++)}`,
              source: srcId,
              target: tgtId,
            })
          }
        }
      }

      const entryNodeIds: string[] = []
      const exitNodeIds: string[] = []
      for (const node of template.nodes) {
        if ((incomingCount.get(node.id) ?? 0) === 0) {
          entryNodeIds.push(...(scopeEntryByOrig.get(node.id) ?? []))
        }
        if ((outgoingCount.get(node.id) ?? 0) === 0) {
          exitNodeIds.push(...(scopeExitByOrig.get(node.id) ?? []))
        }
      }

      return {
        nodes: compiledNodes,
        edges: compiledEdges,
        entryNodeIds,
        exitNodeIds,
      }
    }

    const rootExpanded = expandGraph(
      input.rootTemplate,
      input.invocations,
      0,
      ['root'],
      input.parentVariables ?? {},
      null,
      {},
      {},
      [input.rootTemplate.id],
    )

    const nowIso = input.nowIso ?? new Date().toISOString()
    const compiledTemplate: WorkflowTemplateV2 = workflowTemplateV2Schema.parse({
      ...input.rootTemplate,
      nodes: rootExpanded.nodes,
      edges: rootExpanded.edges,
      updatedAt: nowIso,
    })

    validateWorkflowGraph(
      compiledTemplate.nodes,
      compiledTemplate.edges,
      compiledTemplate.loopPolicy,
    )
    const validationReport = validateTemplateGraph(compiledTemplate)
    if (!validationReport.valid) {
      throw new SubWorkflowCompilationError(validationReport.errors.join('; '))
    }

    const topologicalOrder = getTopologicalSort(compiledTemplate.nodes, compiledTemplate.edges)
    const compilationDigest = createHash('sha256')
      .update(
        JSON.stringify({
          templateId: compiledTemplate.id,
          nodes: compiledTemplate.nodes.map((n) => n.id),
          edges: compiledTemplate.edges.map((e) => `${e.source}->${e.target}`),
          lineageMap,
          boundaryContracts,
        }),
      )
      .digest('hex')

    return {
      compiledTemplate,
      lineageMap,
      entryNodesByInvocation,
      exitNodesByInvocation,
      boundaryContracts,
      topologicalOrder,
      maxDepthReached,
      totalFlattenedNodes: compiledTemplate.nodes.length,
      compilationDigest,
    }
  }
}
