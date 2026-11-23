import { z } from 'zod'
import { capabilitySchema, roleSchema, ruleScopeSchema } from './enums'
import {
  agentBindingIdSchema,
  projectIdSchema,
  repositoryIdSchema,
  ruleIdSchema,
  timestampSchema,
} from './ids'

/**
 * The repository a project is bound to.
 *
 * `absolutePath` is the one place in the domain where a native path appears —
 * everything downstream is repository-relative, so scope globs and prompt packets
 * stay portable.
 *
 * Build and test commands live here rather than being detected, because guessing
 * them would violate axiom A2 and because a wrong guess produces evidence that
 * looks real (#33).
 */
export const repositorySchema = z.strictObject({
  id: repositoryIdSchema,
  absolutePath: z.string().min(1),
  defaultBranch: z.string().min(1),
  /** Verbatim shell commands. Forge runs these itself to produce evidence. */
  buildCommand: z.string().min(1).nullable(),
  testCommand: z.string().min(1).nullable(),
  /** Free-form technology tags, used by the context engine when ranking files. */
  tech: z.array(z.string().min(1)).readonly(),
})

export type Repository = z.infer<typeof repositorySchema>

/**
 * A standing policy statement.
 *
 * Distinct from a `Decision`: a rule is ongoing ("never modify migrations"), a
 * decision is a single choice made once. Rules are resolved by scope, with the
 * most specific winning (#19).
 */
export const ruleSchema = z.strictObject({
  id: ruleIdSchema,
  scope: ruleScopeSchema,
  /** Stable key, so a narrower scope can override the same concern. */
  key: z.string().min(1),
  statement: z.string().min(1),
  /** Where this came from — a settings screen, a promoted answer, or a default. */
  source: z.string().min(1),
  createdAt: timestampSchema,
})

export type Rule = z.infer<typeof ruleSchema>

/**
 * Permissions granted to one binding.
 *
 * Enforced by Forge at the boundary it controls, not requested in a prompt
 * (axiom A7). Every field defaults to denied, so a new permission is opt-in rather
 * than inherited by an existing binding.
 */
export const permissionsSchema = z.strictObject({
  readFiles: z.boolean().default(true),
  writeFiles: z.boolean().default(false),
  runTests: z.boolean().default(false),
  runBuild: z.boolean().default(false),
  installPackages: z.boolean().default(false),
  gitRead: z.boolean().default(true),
  /** Off for the MVP: the final commit is the user's call. */
  gitWrite: z.boolean().default(false),
  network: z.boolean().default(false),
})

export type Permissions = z.infer<typeof permissionsSchema>

/**
 * Binds a role to a runtime for one project.
 *
 * `runtimeId` and `accountId` are opaque strings on purpose: the domain must not
 * know that Claude or Antigravity exist (axiom A6). Only the adapters in
 * `infra/runtimes/*` interpret them.
 */
export const agentBindingSchema = z.strictObject({
  id: agentBindingIdSchema,
  role: roleSchema,
  runtimeId: z.string().min(1),
  accountId: z.string().min(1).nullable(),
  /** Declared by the runtime; checked against the role when binding (#31). */
  capabilities: z.array(capabilitySchema).readonly(),
  permissions: permissionsSchema,
})

export type AgentBinding = z.infer<typeof agentBindingSchema>

export const projectSchema = z.strictObject({
  id: projectIdSchema,
  name: z.string().min(1),
  repository: repositorySchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

export type Project = z.infer<typeof projectSchema>
