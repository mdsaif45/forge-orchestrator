import { z } from 'zod'

/**
 * How much an agent may do without stopping to ask.
 *
 * This is the single most consequential setting Forge hands a runtime: it decides
 * whether an agent can touch the user's repository at all. The dogfood run in #130
 * halted in 25 seconds because no mode was passed, so the CLI denied every tool call
 * and the agent could reason about the prompt but never read a file, run a command,
 * or write a change.
 *
 * Named modes rather than a boolean, because "may it act?" is not one question:
 *
 * ```
 * manual             ask before every change            most cautious
 * plan               produce a plan, change nothing     read-only by construction
 * auto               the runtime decides case by case
 * acceptEdits        edits without prompting            DEFAULT
 * bypassPermissions  no prompting at all                least cautious
 * ```
 *
 * `acceptEdits` is the default because it is the weakest mode in which a workflow can
 * actually complete: an implementer that cannot edit produces nothing, and Forge's own
 * guards — scope enforcement, diff reconciliation, and its own build and test runs —
 * are what make an unattended edit safe, not the CLI's prompt.
 */
export const permissionModeSchema = z.enum([
  'manual',
  'plan',
  'auto',
  'acceptEdits',
  'bypassPermissions',
])

export type PermissionMode = z.infer<typeof permissionModeSchema>

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'acceptEdits'

/** What each mode means, for a settings screen that must not make the user guess. */
export const PERMISSION_MODE_DESCRIPTIONS: Readonly<Record<PermissionMode, string>> = {
  manual: 'Always ask before making changes',
  plan: 'Create a plan before making changes',
  auto: 'The agent handles permission decisions',
  acceptEdits: 'Automatically accept all file edits',
  bypassPermissions: 'Accept all permissions without asking',
}
