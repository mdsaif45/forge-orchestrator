import type { PermissionMode } from './permissionMode'
import type { Role } from './enums'
import { permissionsSchema, type Permissions } from './project'

/**
 * Authoritative default permissions per role before any project or binding narrows them.
 *
 * A project or binding may withhold capability, but cannot widen role defaults (A7).
 */
export const ROLE_DEFAULT_PERMISSIONS: Record<Role, Partial<Permissions>> = {
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

/** Resolves the authoritative default permissions for a role. */
export function defaultPermissionsForRole(role: Role): Permissions {
  return permissionsSchema.parse(ROLE_DEFAULT_PERMISSIONS[role])
}

/**
 * Detects permissions granted beyond a role's authoritative defaults.
 * A role cannot be granted permissions excluded from its role definition (Axiom A7).
 */
export function widenedPermissionsForRole(
  role: Role,
  permissions: Partial<Permissions>,
): readonly (keyof Permissions)[] {
  const defaults = defaultPermissionsForRole(role)
  const widened: (keyof Permissions)[] = []
  const keys = Object.keys(permissions) as (keyof Permissions)[]
  for (const key of keys) {
    if (permissions[key] === true && !defaults[key]) {
      widened.push(key)
    }
  }
  return widened
}

/** Raised when a binding grants permissions exceeding the role's authoritative defaults. */
export class InvalidBindingPermissionsError extends Error {
  constructor(
    readonly role: Role,
    readonly widened: readonly (keyof Permissions)[],
  ) {
    super(
      `Agent binding for role "${role}" attempts to widen permissions beyond role ceiling: ${widened.join(
        ', ',
      )}`,
    )
    this.name = 'InvalidBindingPermissionsError'
  }
}

/**
 * Validates that an agent binding does not grant permissions exceeding the role ceiling.
 * Throws InvalidBindingPermissionsError if any unauthorized permission is true.
 */
export function validateBindingPermissions(binding: {
  readonly role: Role
  readonly permissions: Partial<Permissions>
}): void {
  const widened = widenedPermissionsForRole(binding.role, binding.permissions)
  if (widened.length > 0) {
    throw new InvalidBindingPermissionsError(binding.role, widened)
  }
}

/**
 * Calculates effective permissions for a role and optional binding.
 *
 * Invariant (A7 least privilege):
 * `effective permissions = role defaults ∩ applicable binding permissions`
 *
 * When no binding is present, returns role defaults.
 * When a binding is present, each permission flag can only be true if allowed by BOTH
 * the role defaults AND the binding. A binding may narrow permissions, but NEVER widen them.
 */
export function effectivePermissionsForRole(
  role: Role,
  binding?: { readonly permissions: Partial<Permissions> },
): Permissions {
  const defaults = defaultPermissionsForRole(role)
  if (!binding) return defaults

  const bindingPerms = binding.permissions
  return permissionsSchema.parse(
    Object.fromEntries(
      Object.entries(defaults).map(([key, allowedByRole]) => {
        const bindingAllowed = bindingPerms[key as keyof Permissions]
        // Intersection: false from either role default or binding wins.
        return [key, allowedByRole && bindingAllowed !== false]
      }),
    ),
  )
}

/**
 * The permission mode a role runs under, and why.
 *
 * A hosted interactive session can be *asked* for permission; the headless path
 * never could. Measured (#166/#173): under `acceptEdits` a real turn ran its
 * tools and then stopped on
 *
 * ```
 * Bash command / Read data.txt
 * Do you want to proceed?   > 1. Yes   2. Yes, allow...   3. No
 * ```
 *
 * and waited forever, because nothing was there to answer. `acceptEdits`
 * auto-approves *edits* and still prompts for other tool use.
 *
 * So the mode has to be chosen per role rather than globally:
 *
 * ```
 * role         may write   mode                why
 * ──────────   ─────────   ─────────────────   ────────────────────────────────
 * planner      no          plan                read-only by construction; it
 *                                              cannot damage anything, so it
 *                                              needs no prompt to protect it
 * reviewer     no          plan                same
 * implementer  yes         bypassPermissions   must run tools unattended, and
 *                                              the sandbox is the real boundary
 * implementer  no          plan                a binding that withholds write
 *                                              permission wins over the role
 * ```
 *
 * The last row matters: the role says what a step is *for*, the binding says what
 * this agent is *allowed*. When they disagree the binding wins, or a permission a
 * user deliberately withheld would be granted back by the template (A7).
 *
 * **On `bypassPermissions` for an implementer.** This is the blunt instrument and
 * is only defensible because of where it runs: every step executes in a disposable
 * git worktree (never the user's checkout), Forge measures the resulting diff
 * itself, enforces the task's scope against it, and runs the build and tests. The
 * sandbox and that reconciliation are the boundary — not a prompt inside the CLI
 * that no one is present to answer (A3). Surfacing the prompt to the user instead
 * is the better end state and is #173; this is what makes an unattended run
 * possible until then, without pretending the prompt was answered.
 */
export interface RolePermission {
  readonly mode: PermissionMode
  /** Why this mode, in one line, for a log or a settings screen. */
  readonly reason: string
}

export function permissionForRole(role: Role, mayWriteFiles: boolean): RolePermission {
  if (!mayWriteFiles) {
    return {
      mode: 'plan',
      reason:
        role === 'implementer'
          ? 'This agent is not permitted to write files, so it runs read-only'
          : `A ${role} does not modify the repository, so it runs read-only`,
    }
  }

  return {
    mode: 'bypassPermissions',
    reason:
      'Runs unattended in a disposable worktree; Forge reconciles the diff and runs the checks',
  }
}
