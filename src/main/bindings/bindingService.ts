import { projectIdSchema, roleSchema, type Role } from '@shared/domain'
import type { AgentBindingView, RoleBindingsView } from '@shared/ipc'
import type { BindingStore } from '../db/bindingStore'
import { bindRole } from '../runtimes/bindings'
import type { RuntimeRegistry } from '../runtimes/registry'

/**
 * The roles a user can assign a runtime to.
 *
 * `system` and `user` are excluded deliberately: Forge performs those steps itself,
 * so offering a runtime for them would imply a choice that does not exist.
 */
const ASSIGNABLE_ROLES: readonly Role[] = ['planner', 'implementer', 'reviewer']

export class BindingService {
  constructor(
    private readonly bindings: BindingStore,
    private readonly registry: RuntimeRegistry,
  ) {}

  /**
   * Every assignable role with its current binding and the runtimes eligible for it.
   *
   * Eligibility is computed from declared capabilities, so the UI cannot offer a
   * choice that `bindRole` would then refuse — a dropdown whose options are rejected
   * on submit teaches the user nothing about why.
   */
  list(projectId: string): RoleBindingsView {
    const pId = projectIdSchema.parse(projectId)
    const stored = this.bindings.list(pId)

    return {
      roles: ASSIGNABLE_ROLES.map((role) => {
        const binding = stored.find((candidate) => candidate.role === role) ?? null

        return {
          role,
          binding: binding === null ? null : this.toView(binding.runtimeId, binding),
          eligibleRuntimes: this.registry.candidatesForRole(role).map((runtime) => ({
            id: runtime.id,
            simulated: runtime.simulated,
          })),
        }
      }),
    }
  }

  /**
   * Binds a role to a runtime.
   *
   * The capability check lives in `bindRole` and happens here, at binding time, not
   * when a step runs — a read-only runtime bound as the implementer would otherwise
   * fail halfway through a workflow with a half-finished task to clean up.
   */
  set(input: {
    readonly projectId: string
    readonly role: string
    readonly runtimeId: string
  }): AgentBindingView {
    const pId = projectIdSchema.parse(input.projectId)
    const role = roleSchema.parse(input.role)

    const binding = bindRole(this.registry, { role, runtimeId: input.runtimeId })
    const stored = this.bindings.set(pId, binding, 'user', new Date().toISOString())

    return this.toView(stored.runtimeId, stored)
  }

  private toView(
    runtimeId: string,
    binding: { readonly id: string; readonly role: Role; readonly accountId: string | null },
  ): AgentBindingView {
    return {
      id: binding.id,
      role: binding.role,
      runtimeId,
      accountId: binding.accountId,
      // Read from the registry rather than stored on the binding: whether a runtime is
      // simulated is a property of the runtime as it exists now, not of the moment the
      // binding was made (#101).
      simulated: this.registry.has(runtimeId) ? this.registry.resolve(runtimeId).simulated : null,
    }
  }
}
