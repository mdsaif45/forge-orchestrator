/**
 * CONFIG-018: Configuration Schema Deprecation Transformer & Dynamic Rule Migrator
 *
 * Inspects loaded configuration structures against versioned deprecation rules,
 * losslessly transforms deprecated configuration keys into modern schema properties,
 * and produces structured deprecation advisories for workspace administrators.
 *
 * Conforms to Forge Axioms:
 * - A1: Fail-closed evaluation and zero `any`.
 * - A2: Non-destructive transformation preserving unmapped custom keys.
 * - A7: Least privilege configuration enforcement.
 */

export interface DeprecationRule {
  readonly deprecatedKey: string
  readonly modernKey: string
  readonly sinceVersion: string
  readonly advisory: string
  readonly transform?: ((val: unknown) => unknown) | undefined
}

export interface DeprecationAdvisory {
  readonly deprecatedKey: string
  readonly modernKey: string
  readonly value: unknown
  readonly advisory: string
  readonly sinceVersion: string
}

export interface ConfigDeprecationReport {
  readonly isUpToDate: boolean
  readonly deprecationCount: number
  readonly advisories: readonly DeprecationAdvisory[]
  readonly transformedConfig: Record<string, unknown>
  readonly formattedSummary: string
}

export const BUILTIN_DEPRECATION_RULES: readonly DeprecationRule[] = [
  {
    deprecatedKey: 'timeout_ms',
    modernKey: 'timeoutMs',
    sinceVersion: '0.2.0',
    advisory: "Property 'timeout_ms' is deprecated; use camelCase 'timeoutMs'.",
  },
  {
    deprecatedKey: 'max_retries',
    modernKey: 'maxRetries',
    sinceVersion: '0.2.0',
    advisory: "Property 'max_retries' is deprecated; use camelCase 'maxRetries'.",
  },
  {
    deprecatedKey: 'agent_runtime',
    modernKey: 'agentRuntime',
    sinceVersion: '0.2.0',
    advisory: "Property 'agent_runtime' is deprecated; use 'agentRuntime'.",
  },
  {
    deprecatedKey: 'telemetry_enabled',
    modernKey: 'telemetry.enabled',
    sinceVersion: '0.3.0',
    advisory: "Flat property 'telemetry_enabled' is deprecated; use nested 'telemetry.enabled'.",
  },
  {
    deprecatedKey: 'log_level',
    modernKey: 'logging.level',
    sinceVersion: '0.3.0',
    advisory: "Flat property 'log_level' is deprecated; use nested 'logging.level'.",
  },
  {
    deprecatedKey: 'read_only_mode',
    modernKey: 'sandbox.readOnly',
    sinceVersion: '0.3.0',
    advisory: "Property 'read_only_mode' is deprecated; use 'sandbox.readOnly'.",
  },
]

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let curr: unknown = obj
  for (const part of parts) {
    if (curr && typeof curr === 'object') {
      curr = (curr as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return curr
}

function setNestedValue(obj: Record<string, unknown>, path: string, val: unknown): void {
  const parts = path.split('.')
  let curr: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!part) continue
    if (!curr[part] || typeof curr[part] !== 'object') {
      curr[part] = {}
    }
    curr = curr[part] as Record<string, unknown>
  }
  const lastPart = parts[parts.length - 1]
  if (lastPart) {
    curr[lastPart] = val
  }
}

/**
 * Transforms deprecated configuration keys to modern structures according to deprecation rules.
 */
export function transformDeprecatedConfig(
  config: Record<string, unknown>,
  customRules?: readonly DeprecationRule[],
): ConfigDeprecationReport {
  const rules = customRules ?? BUILTIN_DEPRECATION_RULES
  const transformed: Record<string, unknown> = JSON.parse(JSON.stringify(config)) as Record<
    string,
    unknown
  >
  const advisories: DeprecationAdvisory[] = []

  for (const rule of rules) {
    const deprecatedVal = getNestedValue(transformed, rule.deprecatedKey)
    if (deprecatedVal !== undefined) {
      const modernVal = rule.transform ? rule.transform(deprecatedVal) : deprecatedVal

      // If the modern target does not exist yet, migrate it over
      const existingModern = getNestedValue(transformed, rule.modernKey)
      if (existingModern === undefined) {
        setNestedValue(transformed, rule.modernKey, modernVal)
      }

      advisories.push({
        deprecatedKey: rule.deprecatedKey,
        modernKey: rule.modernKey,
        value: deprecatedVal,
        advisory: rule.advisory,
        sinceVersion: rule.sinceVersion,
      })
    }
  }

  const isUpToDate = advisories.length === 0
  const formattedSummary = isUpToDate
    ? '[Config Deprecation] Configuration conforms to current schema without deprecations.'
    : `[Config Deprecation] Found ${String(advisories.length)} deprecated key(s) and modernized schema.`

  return {
    isUpToDate,
    deprecationCount: advisories.length,
    advisories,
    transformedConfig: transformed,
    formattedSummary,
  }
}

/**
 * Audits a configuration object for deprecated properties without performing transformations.
 */
export function auditConfigDeprecations(
  config: Record<string, unknown>,
  customRules?: readonly DeprecationRule[],
): readonly DeprecationAdvisory[] {
  const report = transformDeprecatedConfig(config, customRules)
  return report.advisories
}
