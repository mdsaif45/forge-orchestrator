import { z } from 'zod'
import type { AgentBinding, Permissions } from './project'
import type { AgentReport } from './runtime'
import { matchesAny } from './glob'
import { isForbiddenPath } from './redaction'

/**
 * Policy engine enforcing Axiom A7: least privilege.
 *
 * Prompts are suggestions. The policy engine is a boundary.
 *
 * ```
 * Role         repo read   file write   terminal   git write   network
 * planner          ✓            ✗           ✗          ✗          ✗
 * implementer      ✓            ✓           ✓          ✗          ✗
 * reviewer         ✓            ✗       tests only     ✗          ✗
 * ```
 *
 * It evaluates commands, file modifications, and role capabilities against the
 * permissions granted in the AgentBinding and global safety rules.
 */

export const policyViolationKindSchema = z.enum([
  'unpermitted-write',
  'forbidden-path',
  'dangerous-command',
  'unpermitted-command',
  'secret-exfiltration',
])
export type PolicyViolationKind = z.infer<typeof policyViolationKindSchema>

export const policyViolationSchema = z.strictObject({
  kind: policyViolationKindSchema,
  culprit: z.string().min(1),
  detail: z.string().min(1),
})
export type PolicyViolation = z.infer<typeof policyViolationSchema>

export interface DangerousCommandPattern {
  readonly pattern: RegExp
  readonly name: string
  readonly reason: string
}

/**
 * Commands that are inherently destructive or risk unrecoverable repo corruption.
 *
 * Blocked regardless of role.
 */
export const DANGEROUS_COMMANDS: readonly DangerousCommandPattern[] = [
  {
    pattern: /\bgit\s+push\b.*(?:\s--force\b|\s-f\b|\s\+[a-zA-Z0-9_\-/]+)/i,
    name: 'git-force-push',
    reason: 'Force push can overwrite remote history and destroy teammate work',
  },
  {
    pattern: /\bgit\s+reset\b.*\s--hard\b/i,
    name: 'git-reset-hard',
    reason: 'Hard reset discards uncommitted work irreversibly',
  },
  {
    pattern: /\bgit\s+clean\b.*-[a-zA-Z]*f/i,
    name: 'git-clean-force',
    reason: 'Force clean permanently deletes untracked files',
  },
  {
    pattern: /\bgit\s+branch\b.*(?:\s-D\b|\s-M\b)/i,
    name: 'git-branch-force-delete',
    reason: 'Force deleting or renaming branches can cause unrecoverable ref loss',
  },
  {
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(?:(?:\/|\*|~|\.\.?)(?:\/|\*|\s|$))/i,
    name: 'rm-rf-root-or-wildcard',
    reason: 'Recursive deletion targeting root, wildcard, home, or relative root paths is unsafe',
  },
  {
    pattern: /\b(?:npm|yarn|pnpm)\s+publish\b/i,
    name: 'package-publish',
    reason:
      'Publishing packages to public registries must never be triggered by an autonomous agent',
  },
  {
    pattern: /\b(?:curl|wget)\b.*\|\s*(?:bash|sh|zsh|powershell|pwsh)\b/i,
    name: 'pipe-remote-to-shell',
    reason: 'Piping remote downloads directly into a shell interpreter executes unverified code',
  },
]

/**
 * Checks a single command string against dangerous command patterns and role permissions.
 */
export function assessCommandPolicy(
  command: string,
  permissions: Permissions,
): { readonly allowed: boolean; readonly violation?: PolicyViolation } {
  const trimmed = command.trim()
  if (trimmed === '') return { allowed: true }

  for (const dangerous of DANGEROUS_COMMANDS) {
    if (dangerous.pattern.test(trimmed)) {
      return {
        allowed: false,
        violation: {
          kind: 'dangerous-command',
          culprit: trimmed,
          detail: `Blocked dangerous command (${dangerous.name}): ${dangerous.reason}`,
        },
      }
    }
  }

  // Check git write operations: Forge manages git history; agents should not commit or push.
  const isGitWrite = /\bgit\s+(?:commit|push|merge|rebase|tag|cherry-pick)\b/i.test(trimmed)
  if (isGitWrite) {
    return {
      allowed: false,
      violation: {
        kind: 'unpermitted-command',
        culprit: trimmed,
        detail:
          'Direct git write operations (commit, push, merge, rebase, tag) are not permitted for agents',
      },
    }
  }

  // Check test command permission
  const isTestCommand =
    /\b(?:npm\s+test|vitest|jest|pytest|cargo\s+test|go\s+test|dotnet\s+test)\b/i.test(trimmed)
  if (isTestCommand && !permissions.runTests) {
    return {
      allowed: false,
      violation: {
        kind: 'unpermitted-command',
        culprit: trimmed,
        detail: 'Role is not permitted to execute test runners',
      },
    }
  }

  // Check build command permission
  const isBuildCommand =
    /\b(?:npm\s+run\s+build|vite\s+build|tsc|cargo\s+build|dotnet\s+build)\b/i.test(trimmed)
  if (isBuildCommand && !permissions.runBuild) {
    return {
      allowed: false,
      violation: {
        kind: 'unpermitted-command',
        culprit: trimmed,
        detail: 'Role is not permitted to execute build commands',
      },
    }
  }

  return { allowed: true }
}

export interface StepPolicyInput {
  readonly binding: AgentBinding
  readonly report: AgentReport
  readonly forbiddenPaths?: readonly string[]
  /**
   * Paths this step actually changed, measured from the repository (#144).
   *
   * `report.filesChanged` is a claim, and a read-only role naming a file it merely read is
   * a predictable misreading — a reviewer's whole job is to talk about changed files. When
   * the measurement is supplied, the write check uses it, so a run halts only for a file
   * that was really written.
   *
   * Undefined means no measurement was available, and the claim is used on its own. That
   * is the conservative direction: it can halt a run that did nothing wrong, but it cannot
   * let an unpermitted write through unnoticed.
   */
  readonly changedPaths?: readonly string[]
}

export interface StepPolicyAssessment {
  readonly allowed: boolean
  readonly violations: readonly PolicyViolation[]
}

/**
 * Assesses an agent's step report against role permissions, path restrictions, and command policy.
 */
export function assessStepPolicy(input: StepPolicyInput): StepPolicyAssessment {
  const violations: PolicyViolation[] = []
  const { binding, report, forbiddenPaths = [], changedPaths } = input

  // 1. File write permission
  //
  // Reconciled against the measurement when there is one. The report is a claim, and a
  // read-only role that *names* a file is not the same as one that wrote to it: in the
  // #133 dogfood run every step passed and the workflow still halted, because the reviewer
  // listed the two files it had looked at — one changed by an earlier step, one untracked
  // the whole time. Halting a run on a claim the repository contradicts spends the user's
  // time on a mistake Forge can see is a mistake.
  //
  // The strict reading is not abandoned: `filesChanged` does mean "paths you modified", and
  // an agent that writes without permission is still caught — by this check when there is
  // no measurement, and by the orchestrator's own snapshot comparison regardless.
  const writtenPaths =
    changedPaths === undefined
      ? report.filesChanged
      : report.filesChanged.filter((path) => changedPaths.includes(path))

  if (writtenPaths.length > 0 && !binding.permissions.writeFiles) {
    violations.push({
      kind: 'unpermitted-write',
      culprit: binding.role,
      detail: `Role "${binding.role}" does not have write permissions, but reported ${String(writtenPaths.length)} modified file(s): ${writtenPaths.join(', ')}`,
    })
  }

  // 2. Path boundaries and secret exclusions
  for (const path of report.filesChanged) {
    if (isForbiddenPath(path)) {
      violations.push({
        kind: 'forbidden-path',
        culprit: path,
        detail: `Modification of credential/secret path "${path}" is forbidden by security policy (R7)`,
      })
    } else if (forbiddenPaths.length > 0 && matchesAny(path, forbiddenPaths)) {
      violations.push({
        kind: 'forbidden-path',
        culprit: path,
        detail: `Path "${path}" matches forbidden path policy (R4)`,
      })
    }
  }

  // 3. Commands evaluated
  for (const cmd of report.commandsRun) {
    const assessment = assessCommandPolicy(cmd, binding.permissions)
    if (!assessment.allowed && assessment.violation !== undefined) {
      violations.push(assessment.violation)
    }
  }

  return {
    allowed: violations.length === 0,
    violations,
  }
}

/**
 * Formats multiple policy violations into a human-readable halt reason string.
 */
export function formatPolicyHaltReason(violations: readonly PolicyViolation[]): string {
  if (violations.length === 0) return 'Security policy violation'
  return `Security policy violation:\n- ${violations.map((v) => v.detail).join('\n- ')}`
}
