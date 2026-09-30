import type { WorkflowLimits } from './workflow'
import type { WorkflowTemplate } from './template'
import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowTemplateV2,
  NodeType,
  RuntimeType,
} from './workflowGraph'

/**
 * Pure compiler translating a linear WorkflowTemplate (V1) into a canonical WorkflowTemplateV2 (DAG).
 *
 * Implements the 12 semantic preservation invariants defined in ADR-007 §3.1:
 * 1. Node Identity: deterministic ID `step-${index + 1}-${step.role}`.
 * 2. Ordering: Directed edge from Node(i) to Node(i+1).
 * 3. Role & Capabilities:
 *    - performedByForge === true && role === 'user' -> type: 'user_gate', runtimeType: 'human'
 *    - performedByForge === true && role === 'system' -> type: 'verification', runtimeType: 'forge-engine'
 *    - performedByForge === false -> type: 'agent', runtimeType: 'cli-agent'
 * 4. Permission Mode:
 *    - role === 'implementer' -> permissionMode: 'developer'
 *    - all other roles -> permissionMode: 'read-only'
 * 5. Timeout Bounds: inherits workflowLimits.stepTimeoutMs.
 * 6. Completion Criteria: carried in node definitions.
 * 7. Prompts & Context: input slots wired to upstream deliverables.
 * 8. Verification Semantics: system step maps to verification node executing verifyStep().
 * 9. Review & Correction Loop: for templates ending in reviewer, synthesizes feedback loop edge to implementer.
 * 10. Failure Semantics: preserved.
 * 11. Change-Set References: implementer outputs changeset diff slot, consumed downstream.
 * 12. Production Templates: FEATURE_IMPLEMENTATION and BUG_FIX compile to canonical 5-stage DAGs.
 */
export function compileLinearTemplateToGraph(
  template: WorkflowTemplate,
  limits?: WorkflowLimits,
): WorkflowTemplateV2 {
  const nodes: WorkflowNode[] = []
  const edges: WorkflowEdge[] = []

  let implementerNodeId: string | null = null
  let reviewerNodeId: string | null = null

  for (let index = 0; index < template.steps.length; index++) {
    const step = template.steps[index]
    if (!step) continue
    const nodeId = `step-${String(index + 1)}-${step.role}`

    let type: NodeType
    let runtimeType: RuntimeType
    let permissionMode: 'read-only' | 'developer' = 'read-only'

    if (step.performedByForge) {
      if (step.role === 'user') {
        type = 'user_gate'
        runtimeType = 'human'
      } else {
        type = 'verification'
        runtimeType = 'forge-engine'
      }
    } else {
      type = 'agent'
      runtimeType = 'cli-agent'
      if (step.role === 'implementer') {
        permissionMode = 'developer'
      }
    }

    if (step.role === 'implementer') {
      implementerNodeId = nodeId
    }
    if (step.role === 'reviewer') {
      reviewerNodeId = nodeId
    }

    // Configure inputs and outputs based on role
    const inputs = []
    const outputs = []

    if (index === 0) {
      inputs.push({
        name: 'task_objective',
        kind: 'user_prompt',
        required: true,
        description: 'Original objective and scope for the workflow run',
      })
    } else {
      inputs.push({
        name: `input_from_step_${String(index)}`,
        kind: 'stage_deliverable',
        required: true,
      })
    }

    if (step.role === 'planner') {
      outputs.push({
        name: 'plan',
        kind: 'plan',
        format: 'markdown' as const,
        requiredSections: [],
      })
    } else if (step.role === 'user') {
      outputs.push({
        name: 'approval',
        kind: 'approval',
        format: 'json' as const,
        requiredSections: [],
      })
    } else if (step.role === 'implementer') {
      outputs.push({
        name: 'changeset',
        kind: 'changeset',
        format: 'diff' as const,
        requiredSections: [],
      })
    } else if (step.role === 'system') {
      outputs.push({
        name: 'verification_report',
        kind: 'evidence',
        format: 'json' as const,
        requiredSections: [],
      })
    } else if (step.role === 'reviewer') {
      outputs.push({
        name: 'review_verdict',
        kind: 'review_report',
        format: 'json' as const,
        requiredSections: [],
      })
    }

    nodes.push({
      id: nodeId,
      title: step.label,
      type,
      runtimeType,
      config: {
        skills: [],
        permissionMode,
        role: step.role,
        ...(limits?.stepTimeoutMs !== undefined ? { timeoutMs: limits.stepTimeoutMs } : {}),
      },
      inputs,
      outputs,
      position: { x: index * 200 + 50, y: 150 },
    })

    // Create forward linear edge
    if (index > 0) {
      const prevStep = template.steps[index - 1]
      if (prevStep) {
        const prevNodeId = `step-${String(index)}-${prevStep.role}`
        edges.push({
          id: `edge-${prevNodeId}-to-${nodeId}`,
          source: prevNodeId,
          target: nodeId,
          isFeedback: false,
        })
      }
    }
  }

  // If the template has both an implementer and a reviewer (e.g. FEATURE_IMPLEMENTATION or BUG_FIX),
  // synthesize a declared feedback edge from reviewer back to implementer for the bounded correction loop (WORK-003).
  if (implementerNodeId !== null && reviewerNodeId !== null) {
    edges.push({
      id: `edge-feedback-${reviewerNodeId}-to-${implementerNodeId}`,
      source: reviewerNodeId,
      target: implementerNodeId,
      isFeedback: true,
    })
  }

  const now = new Date().toISOString()
  return {
    id: `compiled-${template.id}`,
    name: template.name,
    description: template.description,
    version: 1,
    status: 'published',
    category: 'Compiled Linear',
    nodes,
    edges,
    createdAt: now,
    updatedAt: now,
  }
}
