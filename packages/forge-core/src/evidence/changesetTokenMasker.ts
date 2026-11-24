export interface TokenMaskerOptions {
  maskHosts?: boolean | undefined
  maskCustomerIds?: boolean | undefined
  maskTokens?: boolean | undefined
  maskIps?: boolean | undefined
  customPatterns?: { pattern: RegExp; maskPrefix: string }[] | undefined
}

export type MaskCategory = 'HOST' | 'CUSTOMER_ID' | 'CREDENTIAL' | 'IP_ADDRESS' | 'CUSTOM'

export interface MaskedTokenDetail {
  originalToken: string
  maskedToken: string
  category: MaskCategory
  occurrences: number
}

export interface MaskingAuditReport {
  totalReplacements: number
  uniqueTokensCount: number
  tokens: MaskedTokenDetail[]
  summary: string
}

export interface ChangesetMaskResult {
  maskedDiff: string
  report: MaskingAuditReport
}

const DEFAULT_PATTERNS: { category: MaskCategory; pattern: RegExp; prefix: string }[] = [
  {
    category: 'CREDENTIAL',
    pattern:
      /\b(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|xox[baprs]-[a-zA-Z0-9-]{20,}|ey[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,})\b/g,
    prefix: 'CREDENTIAL',
  },
  {
    category: 'CUSTOMER_ID',
    pattern: /\b(?:cust|tenant|org)_[a-zA-Z0-9]{6,24}\b/g,
    prefix: 'CUSTOMER_ID',
  },
  {
    category: 'HOST',
    pattern: /\b[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.(?:corp|internal|intranet|local|lan)\b/gi,
    prefix: 'HOST',
  },
  {
    category: 'IP_ADDRESS',
    pattern:
      /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
    prefix: 'PRIVATE_IP',
  },
]

export function maskChangesetTokens(
  rawDiff: string,
  options: TokenMaskerOptions = {},
): ChangesetMaskResult {
  if (!rawDiff) {
    return {
      maskedDiff: '',
      report: {
        totalReplacements: 0,
        uniqueTokensCount: 0,
        tokens: [],
        summary: 'Changeset token masking report: 0 replacements across 0 unique tokens',
      },
    }
  }

  const maskHosts = options.maskHosts ?? true
  const maskCustomerIds = options.maskCustomerIds ?? true
  const maskTokens = options.maskTokens ?? true
  const maskIps = options.maskIps ?? true

  const activeRules: { category: MaskCategory; pattern: RegExp; prefix: string }[] = []

  for (const rule of DEFAULT_PATTERNS) {
    if (rule.category === 'HOST' && !maskHosts) continue
    if (rule.category === 'CUSTOMER_ID' && !maskCustomerIds) continue
    if (rule.category === 'CREDENTIAL' && !maskTokens) continue
    if (rule.category === 'IP_ADDRESS' && !maskIps) continue
    activeRules.push(rule)
  }

  if (options.customPatterns) {
    for (const cp of options.customPatterns) {
      activeRules.push({
        category: 'CUSTOM',
        pattern: cp.pattern,
        prefix: cp.maskPrefix,
      })
    }
  }

  const tokenMapping = new Map<string, { masked: string; category: MaskCategory; count: number }>()
  const categoryCounters = new Map<string, number>()

  let maskedDiff = rawDiff

  for (const rule of activeRules) {
    maskedDiff = maskedDiff.replace(rule.pattern, (match) => {
      let entry = tokenMapping.get(match)
      if (!entry) {
        const count = (categoryCounters.get(rule.prefix) ?? 0) + 1
        categoryCounters.set(rule.prefix, count)
        const masked = `[REDACTED_${rule.prefix}_${String(count)}]`
        entry = { masked, category: rule.category, count: 0 }
        tokenMapping.set(match, entry)
      }
      entry.count += 1
      return entry.masked
    })
  }

  const tokenDetails: MaskedTokenDetail[] = []
  let totalReplacements = 0

  for (const [orig, info] of tokenMapping.entries()) {
    totalReplacements += info.count
    tokenDetails.push({
      originalToken: orig,
      maskedToken: info.masked,
      category: info.category,
      occurrences: info.count,
    })
  }

  const summary = [
    `=== Changeset Token Masking Report ===`,
    `Replacements: ${String(totalReplacements)} occurrences masked across ${String(tokenDetails.length)} unique sensitive tokens`,
    ...tokenDetails.map(
      (d) => `  • [${d.category}] ${d.maskedToken} (occurrences: ${String(d.occurrences)})`,
    ),
  ].join('\n')

  return {
    maskedDiff,
    report: {
      totalReplacements,
      uniqueTokensCount: tokenDetails.length,
      tokens: tokenDetails,
      summary,
    },
  }
}
