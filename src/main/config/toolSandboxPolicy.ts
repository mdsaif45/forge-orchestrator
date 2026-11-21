/**
 * CONFIG-016: Workspace Tool Execution Sandbox Policy Auditor & Permission Validator
 *
 * Enforces least-privilege command execution boundaries within workspace environments,
 * validating requested tool executions, binary invocations, flags, and subcommands
 * against declared workspace security policies.
 *
 * Conforms to Forge Axioms:
 * - A1: Fail-closed security validation (zero `any`).
 * - A2: Rigorous command isolation and execution policy gating.
 * - A7: Least privilege and defense in depth.
 */

export interface ToolExecutionRule {
  readonly binary: string
  readonly allowedSubcommands?: readonly string[]
  readonly prohibitedFlags?: readonly string[]
  readonly allowedFlags?: readonly string[]
  readonly allowArbitraryArgs?: boolean
}

export interface ToolSandboxPolicy {
  readonly allowedBinaries?: readonly string[]
  readonly rules?: readonly ToolExecutionRule[]
  readonly defaultAction: 'allow' | 'block'
}

export interface PolicyCheckResult {
  readonly allowed: boolean
  readonly binary: string
  readonly violationKind?: 'forbidden_binary' | 'prohibited_flag' | 'forbidden_subcommand'
  readonly reason?: string
  readonly formattedSummary: string
}

/**
 * Normalizes binary command string by extracting basename and stripping file extensions (.exe, .cmd, etc.).
 */
export function normalizeBinaryName(rawBinary: string): string {
  const trimmed = rawBinary.trim()
  if (!trimmed) {
    return ''
  }
  // Extract basename from path
  const basename = trimmed.split(/[\\/]/).pop() ?? trimmed
  // Strip common executable extensions
  return basename.replace(/\.(exe|cmd|bat|sh|ps1)$/i, '').toLowerCase()
}

/**
 * Validates a proposed binary execution and argument list against a tool sandbox policy.
 */
export function validateToolExecutionPolicy(
  binary: string,
  args: readonly string[],
  policy: ToolSandboxPolicy,
): PolicyCheckResult {
  const normalized = normalizeBinaryName(binary)

  if (!normalized) {
    return {
      allowed: false,
      binary,
      violationKind: 'forbidden_binary',
      reason: 'Binary name cannot be empty',
      formattedSummary: '[Tool Policy Denied] Empty binary name specified.',
    }
  }

  // Check binary whitelist if specified
  if (policy.allowedBinaries && policy.allowedBinaries.length > 0) {
    const isWhitelisted = policy.allowedBinaries.some((b) => normalizeBinaryName(b) === normalized)
    if (!isWhitelisted && policy.defaultAction === 'block') {
      return {
        allowed: false,
        binary: normalized,
        violationKind: 'forbidden_binary',
        reason: `Binary '${normalized}' is not in the allowed binaries whitelist: [${policy.allowedBinaries.join(', ')}]`,
        formattedSummary: `[Tool Policy Denied] Binary '${normalized}' is forbidden by workspace execution policy.`,
      }
    }
  }

  // Find matching rule for this binary if any
  const rule = policy.rules?.find((r) => normalizeBinaryName(r.binary) === normalized)

  if (rule) {
    // Check for prohibited flags
    if (rule.prohibitedFlags && rule.prohibitedFlags.length > 0) {
      for (const arg of args) {
        for (const prohibited of rule.prohibitedFlags) {
          if (arg === prohibited || arg.startsWith(`${prohibited}=`)) {
            return {
              allowed: false,
              binary: normalized,
              violationKind: 'prohibited_flag',
              reason: `Prohibited flag '${arg}' detected for binary '${normalized}'`,
              formattedSummary: `[Tool Policy Denied] Prohibited flag '${arg}' is blocked for binary '${normalized}'.`,
            }
          }
        }
      }
    }

    // Check allowed subcommands
    if (rule.allowedSubcommands && rule.allowedSubcommands.length > 0) {
      // Find first non-flag argument
      const subcommand = args.find((a) => !a.startsWith('-'))
      if (!subcommand) {
        return {
          allowed: false,
          binary: normalized,
          violationKind: 'forbidden_subcommand',
          reason: `Binary '${normalized}' requires a subcommand from [${rule.allowedSubcommands.join(', ')}], but none was provided`,
          formattedSummary: `[Tool Policy Denied] Subcommand required for '${normalized}'.`,
        }
      }
      const isSubcommandAllowed = rule.allowedSubcommands.includes(subcommand)
      if (!isSubcommandAllowed) {
        return {
          allowed: false,
          binary: normalized,
          violationKind: 'forbidden_subcommand',
          reason: `Subcommand '${subcommand}' is not in allowed list for '${normalized}': [${rule.allowedSubcommands.join(', ')}]`,
          formattedSummary: `[Tool Policy Denied] Subcommand '${subcommand}' is not permitted for binary '${normalized}'.`,
        }
      }
    }

    // Check allowed flags if arbitrary args are not permitted
    if (rule.allowedFlags && rule.allowedFlags.length > 0 && !rule.allowArbitraryArgs) {
      for (const arg of args) {
        if (arg.startsWith('-')) {
          const flagKey = arg.split('=')[0]
          const isAllowedFlag = rule.allowedFlags.some((f) => f === arg || f === flagKey)
          if (!isAllowedFlag) {
            return {
              allowed: false,
              binary: normalized,
              violationKind: 'prohibited_flag',
              reason: `Flag '${arg}' is not in allowed flags list for '${normalized}': [${rule.allowedFlags.join(', ')}]`,
              formattedSummary: `[Tool Policy Denied] Flag '${arg}' is not in allowed flags list for '${normalized}'.`,
            }
          }
        }
      }
    }
  } else if (
    policy.defaultAction === 'block' &&
    (!policy.allowedBinaries || policy.allowedBinaries.length === 0)
  ) {
    return {
      allowed: false,
      binary: normalized,
      violationKind: 'forbidden_binary',
      reason: `No matching rule for binary '${normalized}' and defaultAction is 'block'`,
      formattedSummary: `[Tool Policy Denied] Default policy blocked unlisted binary '${normalized}'.`,
    }
  }

  return {
    allowed: true,
    binary: normalized,
    formattedSummary: `[Tool Policy Permitted] Execution of '${normalized}' with ${String(args.length)} argument(s) is allowed.`,
  }
}
