import type { PermissionMode } from './permissionMode'
import type { Role } from './enums'

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
