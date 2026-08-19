import { randomUUID } from 'node:crypto'
import {
  agentBindingIdSchema,
  agentBindingSchema,
  canHoldRole,
  missingCapabilities,
  permissionsSchema,
  type AgentBinding,
  type Capability,
  type Role,
} from '@shared/domain'
import { IncapableRuntimeError, type RuntimeRegistry } from './registry'

/**
 * Role bindings, resolved per project.
 *
 * ```
 * template names a ROLE  ──>  binding names a RUNTIME  ──>  registry resolves it
 * ```
 *
 * The indirection is the whole point of A6: swapping which runtime plans and which
 * implements is a change to binding data, never to code. A test asserts exactly that by
 * swapping two bindings and running the same template.
 *
 * The capability check happens **here**, when a binding is made, not when a step runs. A
 * read-only runtime bound as the implementer would otherwise fail halfway through a workflow
 * with a half-finished task to clean up.
 */

/** Default permissions per role, before a project narrows them. */
const ROLE_PERMISSIONS: Record<Role, Partial<ReturnType<typeof permissionsSchema.parse>>> = {
  // A planner reads and reasons. Giving it write access would let a plan quietly become an
  // implementation, which is the boundary #42's discussion mode exists to enforce.
  planner: { readFiles: true, gitRead: true },
  implementer: { readFiles: true, writeFiles: true, runTests: true, runBuild: true, gitRead: true },
  // A reviewer runs tests to check a claim but never edits: a reviewer that could fix what it
  // found would have no reason to report it.
  reviewer: { readFiles: true, runTests: true, gitRead: true },
  tester: { readFiles: true, runTests: true, runBuild: true, gitRead: true },
  'security-reviewer': { readFiles: true, runTests: true, gitRead: true },
  // Forge performs these itself; no agent process is involved.
  system: { readFiles: true, gitRead: true },
  user: {},
}

export interface CreateBindingInput {
  readonly role: Role
  readonly runtimeId: string
  readonly accountId?: string | null
  /** Narrows the role's defaults. Cannot widen them — see `bindRole`. */
  readonly permissions?: Partial<ReturnType<typeof permissionsSchema.parse>>
}

/**
 * Binds a role to a runtime, refusing a runtime that cannot perform it.
 *
 * Permissions are the intersection of the role's defaults and anything the caller asked for,
 * so a project may take capability away but never add it. A settings screen that could grant
 * an implementer's write access to a reviewer would make the role distinction decorative
 * (A7).
 */
export function bindRole(registry: RuntimeRegistry, input: CreateBindingInput): AgentBinding {
  const runtime = registry.resolve(input.runtimeId)

  if (!canHoldRole(runtime.capabilities, input.role)) {
    throw new IncapableRuntimeError(
      input.runtimeId,
      input.role,
      missingCapabilities(runtime.capabilities, input.role),
    )
  }

  const defaults = permissionsSchema.parse(ROLE_PERMISSIONS[input.role])
  const requested = input.permissions ?? {}

  const permissions = permissionsSchema.parse(
    Object.fromEntries(
      Object.entries(defaults).map(([key, allowedByRole]) => {
        const asked = requested[key as keyof typeof requested]
        // Intersection: `false` from either side wins. A caller cannot turn on something the
        // role does not have.
        return [key, allowedByRole && asked !== false]
      }),
    ),
  )

  return agentBindingSchema.parse({
    id: agentBindingIdSchema.parse(randomUUID()),
    role: input.role,
    runtimeId: input.runtimeId,
    accountId: input.accountId ?? null,
    // Recorded as declared at bind time, so a later capability change in the adapter is
    // visible as a difference rather than silently taking effect.
    capabilities: runtime.capabilities,
    permissions,
  })
}

/** Raised when a template needs a role no binding covers. */
export class UnboundRoleError extends Error {
  constructor(
    readonly role: Role,
    bound: readonly Role[],
  ) {
    super(
      `No runtime is bound to the "${role}" role. Bound roles: ${
        bound.length === 0 ? '(none)' : bound.join(', ')
      }`,
    )
    this.name = 'UnboundRoleError'
  }
}

/**
 * The bindings a workflow run uses, indexed by role.
 *
 * One binding per role, which the database also enforces with a unique constraint on
 * (project, role). Two runtimes bound to one role would make which one runs depend on
 * ordering.
 */
export class BindingSet {
  private readonly byRole = new Map<Role, AgentBinding>()

  constructor(bindings: readonly AgentBinding[] = []) {
    for (const binding of bindings) this.set(binding)
  }

  set(binding: AgentBinding): void {
    this.byRole.set(binding.role, binding)
  }

  get(role: Role): AgentBinding | null {
    return this.byRole.get(role) ?? null
  }

  require(role: Role): AgentBinding {
    const binding = this.get(role)
    if (binding === null) throw new UnboundRoleError(role, [...this.byRole.keys()])
    return binding
  }

  roles(): readonly Role[] {
    return [...this.byRole.keys()]
  }

  /**
   * Every role a template needs but nothing is bound to.
   *
   * Checked before a run starts rather than discovered at the step that needs it: a workflow
   * that halts at step three because nobody bound a reviewer has already done work that now
   * has to be thrown away.
   */
  missingFor(roles: readonly Role[]): readonly Role[] {
    return roles.filter((role) => role !== 'system' && role !== 'user' && !this.byRole.has(role))
  }
}

/** Whether a binding permits a capability, for the policy engine to enforce later (#37). */
export function permits(
  binding: AgentBinding,
  capability: keyof AgentBinding['permissions'],
): boolean {
  return binding.permissions[capability]
}

/** The capabilities a role requires, for a settings screen to explain a refusal. */
export function requiredCapabilities(role: Role): readonly Capability[] {
  return missingCapabilities([], role)
}
