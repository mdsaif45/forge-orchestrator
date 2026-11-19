import { z } from 'zod'
import { forgeConfigSchema, type ForgeConfig, type ForgeProfile } from './forgeConfig'

/**
 * Configuration tiers in order of ascending precedence:
 * Global (lowest) -> Workspace -> Profile -> CLI (highest).
 */
export type ConfigTier = 'global' | 'workspace' | 'profile' | 'cli'

/**
 * Schema for an administrative policy lock rule.
 * Conforms to Axiom A2 (Fail-closed) and Axiom A7 (Least privilege & security sandboxing).
 */
export const policyLockRuleSchema = z.strictObject({
  /** Configuration key path (e.g. 'security.allowExecutionOutsideWorkspace', 'telemetry', 'dataDir'). */
  key: z.string().min(1),
  /** Optional enforced value. If provided, effective config must match this exact value. */
  lockedValue: z.unknown().optional(),
  /** If true, lower tiers are strictly forbidden from overriding this key. Defaults to true. */
  disallowOverride: z.boolean().default(true),
  /** Administrative or compliance rationale for this policy lock. */
  description: z.string().min(1),
})

export type PolicyLockRule = z.infer<typeof policyLockRuleSchema>

export interface PolicyViolation {
  readonly key: string
  readonly rule: PolicyLockRule
  readonly attemptedTier: ConfigTier
  readonly attemptedValue: unknown
  readonly expectedValue?: unknown
  readonly reason: string
}

export interface ConfigLineageEntry {
  readonly key: string
  readonly value: unknown
  readonly definedInTier: ConfigTier
  readonly isLocked: boolean
}

export interface ResolvedHierarchicalConfigResult {
  readonly effectiveConfig: ForgeConfig
  readonly lineage: Readonly<Record<string, ConfigLineageEntry>>
}

export interface ConfigPolicyAuditResult {
  readonly valid: boolean
  readonly violations: readonly PolicyViolation[]
  readonly effectiveConfig?: ForgeConfig | undefined
  readonly formattedSummary: string
}

export interface HierarchicalTiersInput {
  readonly global?: Partial<ForgeConfig> | undefined
  readonly workspace?: Partial<ForgeConfig> | undefined
  readonly profile?: Partial<ForgeProfile> | undefined
  readonly cli?: Partial<ForgeConfig> | undefined
}

function getNestedValue(obj: unknown, path: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const output = { ...target }
  for (const [key, val] of Object.entries(source)) {
    if (val === undefined) continue
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      key in output &&
      output[key] !== null &&
      typeof output[key] === 'object' &&
      !Array.isArray(output[key])
    ) {
      output[key] = deepMerge(
        output[key] as Record<string, unknown>,
        val as Record<string, unknown>,
      )
    } else {
      output[key] = val
    }
  }
  return output
}

/**
 * Resolves configuration values across hierarchical tiers in order of precedence:
 * Global -> Workspace -> Profile -> CLI.
 */
export function resolveHierarchicalConfig(
  tiers: HierarchicalTiersInput,
  policyRules: readonly PolicyLockRule[] = [],
): ResolvedHierarchicalConfigResult {
  const merged: Record<string, unknown> = {}
  const lineage: Record<string, ConfigLineageEntry> = {}
  const lockedKeys = new Set(policyRules.map((r) => r.key))

  const tierOrder: readonly { tier: ConfigTier; data?: Record<string, unknown> | undefined }[] = [
    { tier: 'global', data: tiers.global },
    { tier: 'workspace', data: tiers.workspace },
    { tier: 'profile', data: tiers.profile },
    { tier: 'cli', data: tiers.cli },
  ]

  for (const { tier, data } of tierOrder) {
    if (!data) continue

    const recordLineage = (prefix: string, obj: Record<string, unknown>): void => {
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) continue
        const fullKey = prefix ? `${prefix}.${k}` : k
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          recordLineage(fullKey, v as Record<string, unknown>)
        } else {
          lineage[fullKey] = {
            key: fullKey,
            value: v,
            definedInTier: tier,
            isLocked: lockedKeys.has(fullKey),
          }
        }
      }
    }

    recordLineage('', data)
    Object.assign(merged, deepMerge(merged, data))
  }

  const effectiveConfig = forgeConfigSchema.parse(merged)

  return {
    effectiveConfig,
    lineage,
  }
}

/**
 * Audits hierarchical configurations against administrative policy locks.
 * Strictly fails closed if any unauthorized tier overrides or violates locked settings.
 */
export function auditConfigAgainstPolicies(
  tiers: HierarchicalTiersInput,
  policyRules: readonly PolicyLockRule[],
): ConfigPolicyAuditResult {
  const violations: PolicyViolation[] = []

  for (const rule of policyRules) {
    const validatedRule = policyLockRuleSchema.parse(rule)
    const key = validatedRule.key

    const globalVal = getNestedValue(tiers.global, key)
    const workspaceVal = getNestedValue(tiers.workspace, key)
    const profileVal = getNestedValue(tiers.profile, key)
    const cliVal = getNestedValue(tiers.cli, key)

    // Check enforced locked value if configured
    if (validatedRule.lockedValue !== undefined) {
      const expected = validatedRule.lockedValue
      const tiersToCheck: readonly { tier: ConfigTier; val: unknown }[] = [
        { tier: 'global', val: globalVal },
        { tier: 'workspace', val: workspaceVal },
        { tier: 'profile', val: profileVal },
        { tier: 'cli', val: cliVal },
      ]

      for (const { tier, val } of tiersToCheck) {
        if (val !== undefined && JSON.stringify(val) !== JSON.stringify(expected)) {
          violations.push({
            key,
            rule: validatedRule,
            attemptedTier: tier,
            attemptedValue: val,
            expectedValue: expected,
            reason: `Tier '${tier}' attempts to set '${key}' to ${JSON.stringify(val)}, but administrative policy strictly enforces ${JSON.stringify(expected)} (${validatedRule.description}).`,
          })
        }
      }
    }

    // Check override prohibition: if global (or workspace) set a value, lower tiers cannot override
    if (validatedRule.disallowOverride) {
      if (globalVal !== undefined) {
        if (
          workspaceVal !== undefined &&
          JSON.stringify(workspaceVal) !== JSON.stringify(globalVal)
        ) {
          violations.push({
            key,
            rule: validatedRule,
            attemptedTier: 'workspace',
            attemptedValue: workspaceVal,
            expectedValue: globalVal,
            reason: `Workspace config overrides locked policy key '${key}' (${validatedRule.description}).`,
          })
        }
        if (profileVal !== undefined && JSON.stringify(profileVal) !== JSON.stringify(globalVal)) {
          violations.push({
            key,
            rule: validatedRule,
            attemptedTier: 'profile',
            attemptedValue: profileVal,
            expectedValue: globalVal,
            reason: `Profile config overrides locked policy key '${key}' (${validatedRule.description}).`,
          })
        }
        if (cliVal !== undefined && JSON.stringify(cliVal) !== JSON.stringify(globalVal)) {
          violations.push({
            key,
            rule: validatedRule,
            attemptedTier: 'cli',
            attemptedValue: cliVal,
            expectedValue: globalVal,
            reason: `CLI arguments override locked policy key '${key}' (${validatedRule.description}).`,
          })
        }
      } else if (validatedRule.lockedValue !== undefined) {
        // If global didn't set it but lockedValue exists, any tier differing from lockedValue was caught above
      }
    }
  }

  if (violations.length > 0) {
    const lines = [
      `=== ADMINISTRATIVE POLICY AUDIT FAILED (${String(violations.length)} violation(s)) ===`,
      ...violations.map(
        (v, i) =>
          `[${String(i + 1)}] Key: ${v.key} | Tier: ${v.attemptedTier} | Reason: ${v.reason}`,
      ),
    ]
    return {
      valid: false,
      violations,
      effectiveConfig: undefined,
      formattedSummary: lines.join('\n'),
    }
  }

  // If no violations, resolve the effective config
  const { effectiveConfig, lineage } = resolveHierarchicalConfig(tiers, policyRules)

  const summaryLines = [
    `=== ADMINISTRATIVE POLICY AUDIT PASSED ===`,
    `Policy Rules Evaluated: ${String(policyRules.length)}`,
    `Effective Config Resolved Keys: ${String(Object.keys(lineage).length)}`,
  ]

  return {
    valid: true,
    violations: [],
    effectiveConfig,
    formattedSummary: summaryLines.join('\n'),
  }
}
