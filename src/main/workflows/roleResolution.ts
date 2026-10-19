import {
  defaultPermissionsForRole,
  missingCapabilities,
  type AgentBinding,
  type Capability,
  type IAgentRuntime,
  type ProjectId,
  type Role,
  type WorkflowNode,
} from '@shared/domain'
import { AmbiguousRoleBindingError, UnboundRoleError, type BindingSet } from '../runtimes/bindings'
import {
  IncapableRuntimeError,
  UnknownRuntimeError,
  type RuntimeRegistry,
} from '../runtimes/registry'
import type { BindingStore } from '../db/bindingStore'

export interface ResolveRoleRuntimeOptions {
  readonly node: WorkflowNode
  readonly projectId?: ProjectId | undefined
  readonly executionBindings?: BindingSet | undefined
  readonly compositionBindings?: BindingSet | undefined
  readonly bindingStore?: BindingStore | undefined
  readonly registry: RuntimeRegistry
  readonly defaultRuntimeId?: string | undefined
}

export type BindingSource =
  | 'node-explicit'
  | 'execution-binding'
  | 'composition-binding'
  | 'project-store'
  | 'default-runtime'

export interface ResolvedRoleRuntime {
  readonly runtime: IAgentRuntime
  readonly runtimeId: string
  readonly role: Role
  readonly source: BindingSource
  readonly binding?: AgentBinding | undefined
}

/**
 * Determines whether a workflow node permits file write operations based on its
 * configuration and outputs.
 *
 * In Forge execution semantics:
 * - Omitted `permissionMode` defaults to 'developer' (as defined by `nodeRuntimeConfigSchema`),
 *   which permits file writes.
 * - 'developer' and 'full-access' permit file writes.
 * - 'read-only' disables file writes, unless the node explicitly declares a diff output
 *   (which requires file modifications to produce the diff).
 */
export function nodeRequiresFileWrite(node: WorkflowNode): boolean {
  if (node.config.permissionMode === 'read-only') {
    return node.outputs.some((o) => o.kind === 'diff' || o.format === 'diff')
  }
  return true
}

/**
 * Validates operational capabilities required by the specific node configuration
 * and outputs against the resolved runtime's declared capabilities and effective binding permissions.
 */
export function validateNodeCapabilities(
  runtime: IAgentRuntime,
  node: WorkflowNode,
  role: Role,
  binding?: AgentBinding,
): void {
  // 1. Role capability validation (A6: roles are capability-based)
  const missingForRole = missingCapabilities(runtime.capabilities, role)
  if (missingForRole.length > 0) {
    throw new IncapableRuntimeError(runtime.id, role, missingForRole)
  }

  // 2. Operational capability validation:
  const missingOperational: Capability[] = []
  const effectivePermissions = binding ? binding.permissions : defaultPermissionsForRole(role)

  if (nodeRequiresFileWrite(node)) {
    if (!runtime.capabilities.includes('file-write') || !effectivePermissions.writeFiles) {
      missingOperational.push('file-write')
    }
  }

  // If node requires test execution capability
  if (role === 'tester') {
    if (!runtime.capabilities.includes('test') || !effectivePermissions.runTests) {
      missingOperational.push('test')
    }
  }

  if (missingOperational.length > 0) {
    throw new IncapableRuntimeError(runtime.id, role, Array.from(new Set(missingOperational)))
  }
}

/**
 * Searches execution, composition, or durable project bindings for an applicable
 * binding for the specified role.
 */
function findApplicableBinding(
  options: ResolveRoleRuntimeOptions,
  role: Role,
): AgentBinding | undefined {
  if (options.executionBindings) {
    const binding = options.executionBindings.get(role)
    if (binding !== null) return binding
  }
  if (options.compositionBindings) {
    const binding = options.compositionBindings.get(role)
    if (binding !== null) return binding
  }
  if (options.bindingStore && options.projectId) {
    const binding = options.bindingStore.find(options.projectId, role)
    if (binding !== null) return binding
  }
  return undefined
}

/**
 * Resolves a workflow node's declared role to a registered IAgentRuntime according to
 * authoritative precedence rules, and runs capability preflight before any side effects:
 *
 * Precedence:
 * 1. Explicit node-level runtime selection: `node.config.providerId`
 * 2. Explicit execution-level role binding: `executionBindings`
 * 3. Explicit composition-level role binding: `compositionBindings`
 * 4. Durable project-level binding: `bindingStore.find(projectId, role)`
 * 5. Configured default runtime: `defaultRuntimeId` when capable of holding the role
 *
 * Enforces fail-closed safety:
 * - Never silently falls back to arbitrary candidate runtimes (`candidatesForRole[0]`).
 * - Throws UnknownRuntimeError if a named runtime is not registered.
 * - Throws IncapableRuntimeError if a runtime lacks required role or operational capabilities.
 * - Throws AmbiguousRoleBindingError if multiple candidates exist without an authoritative binding.
 * - Throws UnboundRoleError if no runtime is bound to the role.
 */
export function resolveRoleRuntime(options: ResolveRoleRuntimeOptions): ResolvedRoleRuntime {
  const role: Role = options.node.config.role ?? 'implementer'

  // Precedence 1: Explicit node-level provider selection
  if (options.node.config.providerId) {
    const runtimeId = options.node.config.providerId
    if (!options.registry.has(runtimeId)) {
      throw new UnknownRuntimeError(runtimeId, options.registry.ids())
    }
    const runtime = options.registry.resolve(runtimeId)
    const binding = findApplicableBinding(options, role)
    validateNodeCapabilities(runtime, options.node, role, binding)
    return {
      runtime,
      runtimeId,
      role,
      source: 'node-explicit',
      ...(binding !== undefined ? { binding } : {}),
    }
  }

  // Precedence 2: Explicit execution-level role binding
  if (options.executionBindings) {
    const binding = options.executionBindings.get(role)
    if (binding !== null) {
      if (!options.registry.has(binding.runtimeId)) {
        throw new UnknownRuntimeError(binding.runtimeId, options.registry.ids())
      }
      const runtime = options.registry.resolve(binding.runtimeId)
      validateNodeCapabilities(runtime, options.node, role, binding)
      return {
        runtime,
        runtimeId: binding.runtimeId,
        role,
        source: 'execution-binding',
        binding,
      }
    }
  }

  // Precedence 3: Explicit composition-level role binding
  if (options.compositionBindings) {
    const binding = options.compositionBindings.get(role)
    if (binding !== null) {
      if (!options.registry.has(binding.runtimeId)) {
        throw new UnknownRuntimeError(binding.runtimeId, options.registry.ids())
      }
      const runtime = options.registry.resolve(binding.runtimeId)
      validateNodeCapabilities(runtime, options.node, role, binding)
      return {
        runtime,
        runtimeId: binding.runtimeId,
        role,
        source: 'composition-binding',
        binding,
      }
    }
  }

  // Precedence 4: Durable project-level binding from BindingStore
  if (options.bindingStore && options.projectId) {
    const binding = options.bindingStore.find(options.projectId, role)
    if (binding !== null) {
      if (!options.registry.has(binding.runtimeId)) {
        throw new UnknownRuntimeError(binding.runtimeId, options.registry.ids())
      }
      const runtime = options.registry.resolve(binding.runtimeId)
      validateNodeCapabilities(runtime, options.node, role, binding)
      return {
        runtime,
        runtimeId: binding.runtimeId,
        role,
        source: 'project-store',
        binding,
      }
    }
  }

  // Precedence 5: Configured default runtime
  if (options.defaultRuntimeId) {
    const runtimeId = options.defaultRuntimeId
    if (!options.registry.has(runtimeId)) {
      throw new UnknownRuntimeError(runtimeId, options.registry.ids())
    }
    const runtime = options.registry.resolve(runtimeId)
    validateNodeCapabilities(runtime, options.node, role)
    return {
      runtime,
      runtimeId,
      role,
      source: 'default-runtime',
    }
  }

  // If none applied, check ambiguity across available capable runtimes
  const candidates = options.registry.candidatesForRole(role)
  if (candidates.length > 1) {
    throw new AmbiguousRoleBindingError(
      role,
      candidates.map((c) => c.id),
    )
  }

  // Missing role: fail closed. Bound roles collected from active bindings and stores
  const boundRoles: Role[] = []
  if (options.executionBindings) boundRoles.push(...options.executionBindings.roles())
  if (options.compositionBindings) boundRoles.push(...options.compositionBindings.roles())
  if (options.bindingStore && options.projectId) {
    boundRoles.push(...options.bindingStore.list(options.projectId).map((b) => b.role))
  }

  throw new UnboundRoleError(role, Array.from(new Set(boundRoles)))
}
