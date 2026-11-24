export interface PromptOptimizationOptions {
  /** Target token boundary for cache checkpoints (e.g. 1024 or 2048). Defaults to 1024. */
  readonly targetTokenBoundary?: number | undefined
  /** Approximate characters per token (default: 4). */
  readonly charsPerToken?: number | undefined
}

export interface PromptOptimizationReport {
  readonly valid: boolean
  readonly totalBytes: number
  readonly estimatedTokens: number
  readonly staticPrefixBytes: number
  readonly staticPrefixTokens: number
  readonly dynamicBytes: number
  readonly dynamicTokens: number
  readonly cacheabilityRatio: number
  readonly segments: readonly {
    readonly name: string
    readonly bytes: number
    readonly estimatedTokens: number
    readonly cacheable: boolean
  }[]
  readonly formattedSummary: string
  readonly error?: string | undefined
}

/**
 * Analyzes and optimizes prompt context packets for prefix caching (Axiom A5).
 *
 * Implements Axiom A5 (Bounded token consumption and latency):
 * Splits prompt packets into stable static prefixes (system instructions, architecture context,
 * tool definitions) versus dynamic turn history, calculating cacheability metrics.
 */
export function optimizePromptPacket(
  rawPacket: string | Record<string, unknown>,
  options: PromptOptimizationOptions = {},
): PromptOptimizationReport {
  const charsPerToken = options.charsPerToken ?? 4
  let parsed: Record<string, unknown>

  if (typeof rawPacket === 'string') {
    if (!rawPacket.trim()) {
      return {
        valid: false,
        totalBytes: 0,
        estimatedTokens: 0,
        staticPrefixBytes: 0,
        staticPrefixTokens: 0,
        dynamicBytes: 0,
        dynamicTokens: 0,
        cacheabilityRatio: 0,
        segments: [],
        formattedSummary: 'Empty prompt packet provided; cannot optimize.',
        error: 'Empty prompt packet',
      }
    }
    try {
      parsed = JSON.parse(rawPacket) as Record<string, unknown>
    } catch (err) {
      return {
        valid: false,
        totalBytes: rawPacket.length,
        estimatedTokens: Math.ceil(rawPacket.length / charsPerToken),
        staticPrefixBytes: 0,
        staticPrefixTokens: 0,
        dynamicBytes: rawPacket.length,
        dynamicTokens: Math.ceil(rawPacket.length / charsPerToken),
        cacheabilityRatio: 0,
        segments: [],
        formattedSummary: `Failed to parse prompt packet JSON: ${err instanceof Error ? err.message : String(err)}`,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  } else {
    parsed = rawPacket
  }

  const segments: {
    name: string
    bytes: number
    estimatedTokens: number
    cacheable: boolean
  }[] = []

  let staticPrefixBytes = 0
  let dynamicBytes = 0

  // 1. System Prompt (Static)
  if (typeof parsed.systemPrompt === 'string') {
    const bytes = Buffer.byteLength(parsed.systemPrompt, 'utf8')
    const tokens = Math.ceil(bytes / charsPerToken)
    segments.push({ name: 'System Prompt', bytes, estimatedTokens: tokens, cacheable: true })
    staticPrefixBytes += bytes
  }

  // 2. Tools & Schemas (Static)
  if (parsed.tools !== undefined) {
    const serialized = JSON.stringify(parsed.tools)
    const bytes = Buffer.byteLength(serialized, 'utf8')
    const tokens = Math.ceil(bytes / charsPerToken)
    segments.push({ name: 'Tool Definitions', bytes, estimatedTokens: tokens, cacheable: true })
    staticPrefixBytes += bytes
  }

  // 3. Static Context Files / Repository Guidelines (Static)
  if (Array.isArray(parsed.contextFiles)) {
    const serialized = JSON.stringify(parsed.contextFiles)
    const bytes = Buffer.byteLength(serialized, 'utf8')
    const tokens = Math.ceil(bytes / charsPerToken)
    segments.push({ name: 'Repository Context', bytes, estimatedTokens: tokens, cacheable: true })
    staticPrefixBytes += bytes
  }

  // 4. Task Objective (Static for the run)
  if (typeof parsed.objective === 'string') {
    const bytes = Buffer.byteLength(parsed.objective, 'utf8')
    const tokens = Math.ceil(bytes / charsPerToken)
    segments.push({ name: 'Task Objective', bytes, estimatedTokens: tokens, cacheable: true })
    staticPrefixBytes += bytes
  }

  // 5. Dynamic Conversational Messages & Turns
  if (Array.isArray(parsed.messages) || Array.isArray(parsed.history)) {
    const historyObj = parsed.messages ?? parsed.history
    const serialized = JSON.stringify(historyObj)
    const bytes = Buffer.byteLength(serialized, 'utf8')
    const tokens = Math.ceil(bytes / charsPerToken)
    segments.push({ name: 'Turn History', bytes, estimatedTokens: tokens, cacheable: false })
    dynamicBytes += bytes
  }

  // Fallback for remaining unclassified properties
  const knownKeys = new Set([
    'systemPrompt',
    'tools',
    'contextFiles',
    'objective',
    'messages',
    'history',
  ])
  for (const [k, v] of Object.entries(parsed)) {
    if (!knownKeys.has(k) && v !== undefined) {
      const bytes = Buffer.byteLength(JSON.stringify(v), 'utf8')
      const tokens = Math.ceil(bytes / charsPerToken)
      segments.push({
        name: `Dynamic [${k}]`,
        bytes,
        estimatedTokens: tokens,
        cacheable: false,
      })
      dynamicBytes += bytes
    }
  }

  const totalBytes = staticPrefixBytes + dynamicBytes
  const staticPrefixTokens = Math.ceil(staticPrefixBytes / charsPerToken)
  const dynamicTokens = Math.ceil(dynamicBytes / charsPerToken)
  const estimatedTokens = staticPrefixTokens + dynamicTokens
  const cacheabilityRatio = totalBytes > 0 ? Number((staticPrefixBytes / totalBytes).toFixed(4)) : 0

  const lines: string[] = []
  lines.push('================================================================================')
  lines.push('Prompt Context Cache Optimization Report')
  lines.push(
    `Total: ${String(totalBytes)} bytes (~${String(estimatedTokens)} tokens) | Cacheable: ${(cacheabilityRatio * 100).toFixed(1)}%`,
  )
  lines.push('================================================================================')
  lines.push(
    `  Static Prefix:  ${String(staticPrefixBytes)} bytes (~${String(staticPrefixTokens)} tokens) [CACHEABLE]`,
  )
  lines.push(
    `  Dynamic State:  ${String(dynamicBytes)} bytes (~${String(dynamicTokens)} tokens) [NON-CACHEABLE]`,
  )
  lines.push('\nSegment Breakdown:')
  for (const s of segments) {
    const tag = s.cacheable ? '[CACHEABLE]' : '[DYNAMIC]  '
    lines.push(
      `  • ${tag} ${s.name.padEnd(20)} ${String(s.bytes)} bytes (~${String(s.estimatedTokens)} tokens)`,
    )
  }
  lines.push('================================================================================')

  return {
    valid: true,
    totalBytes,
    estimatedTokens,
    staticPrefixBytes,
    staticPrefixTokens,
    dynamicBytes,
    dynamicTokens,
    cacheabilityRatio,
    segments,
    formattedSummary: lines.join('\n'),
  }
}
