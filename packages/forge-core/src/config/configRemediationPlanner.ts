export interface ConfigPolicyRule {
  key: string
  required?: boolean | undefined
  defaultValue?: unknown
  allowedValues?: unknown[] | undefined
  deprecated?: boolean | undefined
  forbidden?: boolean | undefined
  description?: string | undefined
}

export interface ConfigPolicyBaseline {
  policyName: string
  rules: Record<string, ConfigPolicyRule>
}

export type RemediationActionType =
  'SET_DEFAULT' | 'REMOVE_FORBIDDEN' | 'REPLACE_DEPRECATED' | 'FIX_DISALLOWED'

export interface RemediationAction {
  type: RemediationActionType
  key: string
  currentValue: unknown
  suggestedValue: unknown
  reason: string
}

export interface RemediationOptions {
  strict?: boolean | undefined
}

export interface ConfigRemediationPlan {
  isCompliant: boolean
  complianceScore: number
  driftCount: number
  actions: RemediationAction[]
  patchPreview: Record<string, unknown>
  summary: string
}

function formatUnknown(val: unknown): string {
  if (typeof val === 'string') return val
  if (typeof val === 'number' || typeof val === 'boolean') return String(val)
  return JSON.stringify(val)
}

export function planConfigRemediation(
  activeConfig: Record<string, unknown>,
  policyBaseline: ConfigPolicyBaseline,
  options: RemediationOptions = {},
): ConfigRemediationPlan {
  const actions: RemediationAction[] = []
  const patchAccumulator: Record<string, unknown> = { ...activeConfig }
  const keysToRemove = new Set<string>()
  const strict = options.strict ?? false

  const rules = policyBaseline.rules
  let evaluatedRulesCount = 0

  for (const [key, rule] of Object.entries(rules)) {
    evaluatedRulesCount += 1
    const value = activeConfig[key]
    const exists = value !== undefined && value !== null

    if (!exists) {
      if (rule.required) {
        actions.push({
          type: 'SET_DEFAULT',
          key,
          currentValue: undefined,
          suggestedValue: rule.defaultValue,
          reason: `Required configuration key "${key}" is missing. Applying default value.`,
        })
        patchAccumulator[key] = rule.defaultValue
      }
      continue
    }

    if (rule.forbidden) {
      actions.push({
        type: 'REMOVE_FORBIDDEN',
        key,
        currentValue: value,
        suggestedValue: undefined,
        reason: `Key "${key}" is forbidden by policy "${policyBaseline.policyName}". Removing key.`,
      })
      keysToRemove.add(key)
      continue
    }

    if (rule.allowedValues && rule.allowedValues.length > 0) {
      if (!rule.allowedValues.includes(value)) {
        const valStr = formatUnknown(value)
        const allowedStr = rule.allowedValues.map(formatUnknown).join(', ')
        actions.push({
          type: 'FIX_DISALLOWED',
          key,
          currentValue: value,
          suggestedValue: rule.defaultValue ?? rule.allowedValues[0],
          reason: `Value "${valStr}" for key "${key}" is not in allowed list [${allowedStr}].`,
        })
        patchAccumulator[key] = rule.defaultValue ?? rule.allowedValues[0]
        continue
      }
    }

    if (rule.deprecated) {
      actions.push({
        type: 'REPLACE_DEPRECATED',
        key,
        currentValue: value,
        suggestedValue: rule.defaultValue ?? value,
        reason: `Key "${key}" is marked deprecated in policy "${policyBaseline.policyName}".`,
      })
    }
  }

  if (strict) {
    for (const [key, value] of Object.entries(activeConfig)) {
      if (!(key in rules)) {
        actions.push({
          type: 'REMOVE_FORBIDDEN',
          key,
          currentValue: value,
          suggestedValue: undefined,
          reason: `Unrecognized key "${key}" is not permitted under strict policy enforcement.`,
        })
        keysToRemove.add(key)
      }
    }
  }

  const patchPreview: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patchAccumulator)) {
    if (!keysToRemove.has(k)) {
      patchPreview[k] = v
    }
  }

  const driftCount = actions.length
  const totalKeys = Math.max(1, evaluatedRulesCount)
  const complianceScore = Math.max(0, Number((1 - driftCount / totalKeys).toFixed(2)))
  const isCompliant = driftCount === 0

  const summary = [
    `=== Configuration Policy Remediation Plan: [${policyBaseline.policyName}] ===`,
    `Status: ${isCompliant ? 'COMPLIANT' : 'DRIFT_DETECTED'} | Compliance Score: ${String(Math.round(complianceScore * 100))}%`,
    `Remediation Actions Required: ${String(driftCount)}`,
    ...actions.map((a) => `  • [${a.type}] ${a.key}: ${a.reason}`),
  ].join('\n')

  return {
    isCompliant,
    complianceScore,
    driftCount,
    actions,
    patchPreview,
    summary,
  }
}
